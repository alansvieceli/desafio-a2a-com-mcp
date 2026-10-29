import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const PORTA = Number(process.env.AGENTE_PORT ?? 7300);
const URL_PUBLICA = process.env.AGENTE_URL ?? `http://localhost:${PORTA}`;
const URL_MCP = process.env.MCP_URL ?? 'http://localhost:7301/mcp';
const PROTOCOLO_MCP = '2026-07-28';

const hex = n => randomBytes(n).toString('hex');
const log = msg => console.error(`[agente] ${msg}`);

// ---------- papel 1: host MCP (cliente de verdade, por HTTP) ----------
// Sem o cliente do SDK de proposito: ele responderia a elicitation sozinho via callback
// e o agente nunca veria o input_required cru, que e o que vira pausa da Task.

let proximoId = 0; // id de JSON-RPC novo a cada request, inclusive no retry

class ErroMcp extends Error {}

async function mcp(metodo, params, nome, traceparent) {
    const meta = {
        'io.modelcontextprotocol/protocolVersion': PROTOCOLO_MCP,
        'io.modelcontextprotocol/clientInfo': { name: 'agente-central-de-salas', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } }
    };
    if (traceparent) {
        // mesmo trace-id da chamada A2A, span-id novo
        const [versao, traceId, , flags] = traceparent.split('-');
        meta.traceparent = `${versao}-${traceId}-${hex(8)}-${flags}`;
    }
    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOLO_MCP,
        'Mcp-Method': metodo
    };
    if (nome) headers['Mcp-Name'] = nome;
    const id = ++proximoId;
    let r;
    try {
        r = await fetch(URL_MCP, {
            method: 'POST',
            headers,
            body: JSON.stringify({ jsonrpc: '2.0', id, method: metodo, params: { ...params, _meta: meta } })
        });
    } catch (e) {
        throw new ErroMcp(`Servidor MCP indisponivel: ${e.message}`);
    }
    const corpo = await r.json().catch(() => ({}));
    if (corpo.error) throw new ErroMcp(corpo.error.message);
    return corpo.result;
}

const textoDe = resultado => (resultado.content ?? []).map(p => p.text ?? '').join('\n');

// ---------- papel 2: servidor A2A (Tasks) ----------

const tasks = new Map(); // id -> Task publica
const pausas = new Map(); // id -> { chave, requestState, argumentos, alternativas, traceparent }  (nunca sai do processo)

const agora = () => new Date().toISOString();

function mensagem(task, role, texto) {
    const m = { messageId: `msg-${hex(6)}`, role, parts: [{ text: texto }] };
    if (role === 'ROLE_AGENT') Object.assign(m, { taskId: task.id, contextId: task.contextId });
    return m;
}

function mudar(task, state, texto) {
    const msg = texto === undefined ? undefined : mensagem(task, 'ROLE_AGENT', texto);
    task.status = { state, timestamp: agora(), ...(msg && { message: msg }) };
    if (msg) task.history.push(msg);
}

const TERMINAIS = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_CANCELED', 'TASK_STATE_FAILED']);

class ErroA2A extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function analisarPedido(texto) {
    const m = texto.trim().match(/^reservar\s+(.*)$/s);
    if (!m) return null;
    const campos = Object.fromEntries([...m[1].matchAll(/(\w+)=(.*?)(?=\s+\w+=|$)/gs)].map(x => [x[1], x[2].trim()]));
    return ['sala', 'inicio', 'fim', 'responsavel'].every(k => campos[k]) ? campos : null;
}

// Traduz o resultado de reservar_sala em estado de Task. O requestState e guardado aqui, opaco.
function aplicarResultado(task, resultado, argumentos, traceparent, politica) {
    if (resultado.resultType === 'input_required') {
        const [chave, pedido] = Object.entries(resultado.inputRequests)[0];
        const campo = pedido.params.requestedSchema.properties.sala;
        const alternativas = campo.enum ?? [campo.const];
        pausas.set(task.id, { chave, requestState: resultado.requestState, argumentos, alternativas, traceparent });
        mudar(task, 'TASK_STATE_INPUT_REQUIRED', `alternativas: ${alternativas.join(', ')}`);
        return;
    }
    if (resultado.isError) return mudar(task, 'TASK_STATE_FAILED', textoDe(resultado));
    const r = resultado.structuredContent;
    if (!r?.reservado) return mudar(task, 'TASK_STATE_CANCELED', `Reserva nao realizada: ${r?.motivo ?? 'sem motivo'}.`);
    const { reserva, sala, inicio, fim, responsavel } = r;
    task.artifacts.push({
        artifactId: `art-${hex(6)}`,
        name: 'reserva',
        parts: [{ text: JSON.stringify({ reserva, sala, inicio, fim, responsavel, politica }) }]
    });
    mudar(task, 'TASK_STATE_COMPLETED', `Reserva ${reserva} confirmada na ${sala}.`);
}

async function executar(task, fn) {
    try {
        await fn();
    } catch (e) {
        if (!(e instanceof ErroMcp)) throw e;
        pausas.delete(task.id);
        mudar(task, 'TASK_STATE_FAILED', e.message);
    }
}

async function iniciar(task, texto, traceparent) {
    const argumentos = analisarPedido(texto);
    if (!argumentos) {
        return mudar(task, 'TASK_STATE_FAILED', 'Pedido invalido: use "reservar sala=<id> inicio=<iso8601> fim=<iso8601> responsavel=<nome>"');
    }
    mudar(task, 'TASK_STATE_WORKING');
    await executar(task, async () => {
        // descoberta em runtime: nada de lista fixa de tools
        const { tools } = await mcp('tools/list', {}, undefined, traceparent);
        if (!tools.some(t => t.name === 'reservar_sala')) throw new ErroMcp('O servidor MCP nao oferece a tool reservar_sala');
        const recurso = await mcp('resources/read', { uri: 'politica://uso' }, 'politica://uso', traceparent);
        const politica = recurso.contents[0].text.split('\n')[0].replace(/^versao:\s*/, '').trim();
        task.politica = politica;
        const resultado = await mcp('tools/call', { name: 'reservar_sala', arguments: argumentos }, 'reservar_sala', traceparent);
        aplicarResultado(task, resultado, argumentos, traceparent, politica);
    });
}

async function continuar(task, texto, traceparent) {
    const pausa = pausas.get(task.id);
    const escolha = texto.trim().match(/^escolha=(\S+)$/)?.[1];
    if (!escolha || (escolha !== 'recusar' && !pausa.alternativas.includes(escolha))) {
        return mudar(task, 'TASK_STATE_INPUT_REQUIRED', `alternativas: ${pausa.alternativas.join(', ')}`);
    }
    const resposta = escolha === 'recusar' ? { action: 'decline' } : { action: 'accept', content: { sala: escolha } };
    pausas.delete(task.id);
    mudar(task, 'TASK_STATE_WORKING');
    await executar(task, async () => {
        // A PONTE (volta): repete o tools/call original, com id novo, devolvendo a mesma chave
        // de inputRequests e o requestState exatamente como o servidor entregou.
        const resultado = await mcp('tools/call', {
            name: 'reservar_sala',
            arguments: pausa.argumentos,
            inputResponses: { [pausa.chave]: resposta },
            requestState: pausa.requestState
        }, 'reservar_sala', traceparent ?? pausa.traceparent);
        aplicarResultado(task, resultado, pausa.argumentos, traceparent ?? pausa.traceparent, task.politica);
    });
}

async function sendMessage(params, traceparent) {
    const msg = params?.message;
    const texto = msg?.parts?.map(p => p.text ?? '').join('') ?? '';
    if (!msg || msg.role !== 'ROLE_USER') throw new ErroA2A(-32602, 'message ausente ou com role invalido');

    let task;
    if (msg.taskId) {
        task = tasks.get(msg.taskId);
        if (!task) throw new ErroA2A(-32001, `Task nao encontrada: ${msg.taskId}`);
        if (TERMINAIS.has(task.status.state)) throw new ErroA2A(-32004, `Task ${task.id} ja esta em estado terminal (${task.status.state})`);
        if (task.status.state !== 'TASK_STATE_INPUT_REQUIRED') throw new ErroA2A(-32004, `Task ${task.id} nao esta aguardando entrada`);
        task.history.push(msg);
        await continuar(task, texto, traceparent);
    } else {
        task = { id: `task-${hex(6)}`, contextId: `ctx-${hex(6)}`, status: {}, history: [msg], artifacts: [] };
        tasks.set(task.id, task);
        mudar(task, 'TASK_STATE_SUBMITTED');
        await iniciar(task, texto, traceparent);
    }
    return { task: publica(task) };
}

function getTask(params) {
    const task = tasks.get(params?.id);
    if (!task) throw new ErroA2A(-32001, `Task nao encontrada: ${params?.id}`);
    return { task: publica(task) };
}

// so os campos do contrato A2A: o requestState vive em `pausas` e nao passa por aqui
const publica = ({ id, contextId, status, history, artifacts }) => ({ id, contextId, status, history, artifacts });

const card = {
    name: 'Central de Salas',
    description: 'Reserva salas de reuniao da Hill Valley Tech.',
    provider: { organization: 'Hill Valley Tech', url: 'https://hillvalley.example' },
    version: '1.0.0',
    supportedInterfaces: [{ url: `${URL_PUBLICA}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{
        id: 'reservar-sala',
        name: 'Reservar sala',
        description: 'Reserva uma sala em um intervalo. Se houver conflito, pergunta qual alternativa usar.',
        tags: ['salas', 'agenda'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
        examples: ['reservar sala=sala-garagem inicio=2026-11-03T14:00:00-03:00 fim=2026-11-03T15:00:00-03:00 responsavel=Marty']
    }]
};

const METODOS = { SendMessage: sendMessage, GetTask: (p) => getTask(p) };

async function rpc(corpo, traceparent) {
    const { id = null, method, params } = corpo ?? {};
    if (corpo?.jsonrpc !== '2.0' || typeof method !== 'string') {
        return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Request invalido' } };
    }
    const fn = METODOS[method];
    if (!fn) return { jsonrpc: '2.0', id, error: { code: -32601, message: `Metodo nao suportado: ${method}` } };
    try {
        return { jsonrpc: '2.0', id, result: await fn(params, traceparent) };
    } catch (e) {
        if (!(e instanceof ErroA2A)) {
            log(`erro interno: ${e.stack}`);
            return { jsonrpc: '2.0', id, error: { code: -32603, message: 'Erro interno' } };
        }
        return { jsonrpc: '2.0', id, error: { code: e.code, message: e.message } };
    }
}

const responder = (res, status, corpo) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(corpo));
};

createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (req.method === 'GET' && pathname === '/.well-known/agent-card.json') return responder(res, 200, card);
    if (req.method === 'POST' && pathname === '/a2a') {
        const partes = [];
        for await (const c of req) partes.push(c);
        let corpo;
        try {
            corpo = JSON.parse(Buffer.concat(partes).toString());
        } catch {
            return responder(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON invalido' } });
        }
        const traceparent = req.headers.traceparent;
        log(`a2a metodo=${corpo?.method} traceparent=${traceparent ?? '-'}`);
        return responder(res, 200, await rpc(corpo, traceparent));
    }
    responder(res, 404, { erro: 'nao encontrado' });
}).listen(PORTA, () => log(`agente A2A em ${URL_PUBLICA} (MCP em ${URL_MCP})`));
