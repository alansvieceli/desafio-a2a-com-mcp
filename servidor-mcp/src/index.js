import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';
import {
    McpServer,
    createMcpHandler,
    createRequestStateCodec,
    inputRequired,
    inputResponse
} from '@modelcontextprotocol/server';

const DADOS = process.env.DADOS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dados');
const PORTA = Number(process.env.MCP_PORT ?? 7301);
const CHAVE_ELICITACAO = 'escolha_de_sala';

// Chave de integridade do requestState: so vem do ambiente, nunca do codigo.
const segredo = process.env.REQUEST_STATE_SECRET ?? '';
if (Buffer.byteLength(segredo) < 32) {
    console.error('REQUEST_STATE_SECRET ausente ou com menos de 32 bytes. Gere com: python3 -c "import secrets; print(secrets.token_hex(32))"');
    process.exit(1);
}
// ponytail: TTL fixo de 10 min (a spec pede 5-30); todos os processos precisam da mesma chave
const codec = createRequestStateCodec({ key: segredo, ttlSeconds: 600 });
// base64url tolera lixo nos bits finais: trocar o ultimo caractere por um "irmao" decodifica para
// os mesmos bytes e passaria na assinatura. Exigimos a forma canonica para qualquer troca falhar.
const verificarEstado = (estado, ctx) => {
    const canonico = typeof estado === 'string' &&
        estado.split('.').slice(1).every(p => Buffer.from(p, 'base64url').toString('base64url') === p);
    if (!canonico) throw new Error('requestState fora da forma canonica');
    return codec.verify(estado, ctx);
};

const salas = JSON.parse(readFileSync(join(DADOS, 'salas.json'), 'utf8'));
const reservas = JSON.parse(readFileSync(join(DADOS, 'reservas.json'), 'utf8'));
const politicaTexto = readFileSync(join(DADOS, 'politica-de-uso.md'), 'utf8');
const politicaVersao = politicaTexto.split('\n')[0].replace(/^versao:\s*/, '').trim();

// ---------- dominio (a unica fonte das regras de sala) ----------

class ErroDeRegra extends Error {}

const MSG = {
    sala: id => `Sala inexistente: ${id}`,
    janela: 'Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00',
    duracao: 'Duracao acima do limite: a politica permite no maximo 2 horas',
    intervalo: 'Intervalo invalido: fim deve ser posterior a inicio',
    semAlternativa: 'Sem alternativas disponiveis no intervalo'
};

// minutos desde a meia-noite em Sao Paulo (-03:00, sem horario de verao)
const minutoSP = ms => {
    const d = new Date(ms - 3 * 3600_000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
};

function validar({ sala, inicio, fim }) {
    const s = salas.find(x => x.id === sala);
    if (!s) throw new ErroDeRegra(MSG.sala(sala));
    const ini = Date.parse(inicio);
    const f = Date.parse(fim);
    if (Number.isNaN(ini) || Number.isNaN(f) || f <= ini) throw new ErroDeRegra(MSG.intervalo);
    const dentro = m => m >= 8 * 60 && m <= 20 * 60;
    if (!dentro(minutoSP(ini)) || !dentro(minutoSP(f))) throw new ErroDeRegra(MSG.janela);
    if (f - ini > 2 * 3600_000) throw new ErroDeRegra(MSG.duracao);
    return { sala: s, ini, fim: f };
}

const conflitos = (salaId, ini, fim) =>
    reservas.filter(r => r.sala === salaId && Date.parse(r.inicio) < fim && ini < Date.parse(r.fim));

function alternativas(sala, ini, fim) {
    return salas
        .filter(s => s.id !== sala.id && s.capacidade >= sala.capacidade && conflitos(s.id, ini, fim).length === 0)
        .sort((a, b) => a.capacidade - b.capacidade || a.id.localeCompare(b.id))
        .slice(0, 3)
        .map(s => s.id);
}

function criarReserva({ sala, inicio, fim, responsavel }) {
    const reserva = { id: `res-${String(reservas.length + 1).padStart(4, '0')}`, sala, inicio, fim, responsavel };
    reservas.push(reserva);
    return reserva;
}

// ---------- respostas das tools ----------

const resposta = estruturado => ({
    content: [{ type: 'text', text: JSON.stringify(estruturado, null, 2) }],
    structuredContent: estruturado
});
const erroDeTool = mensagem => ({ content: [{ type: 'text', text: mensagem }], isError: true });
const comRegras = fn => async (...args) => {
    try {
        return await fn(...args);
    } catch (e) {
        if (e instanceof ErroDeRegra) return erroDeTool(e.message);
        throw e;
    }
};

const concluida = r => resposta({
    reserva: r.id, reservado: true, sala: r.sala, inicio: r.inicio, fim: r.fim,
    responsavel: r.responsavel, politica: politicaVersao, motivo: null
});
const recusada = motivo => resposta({
    reserva: null, reservado: false, sala: null, inicio: null, fim: null,
    responsavel: null, politica: null, motivo
});

const argsReserva = z.object({
    sala: z.string(), inicio: z.string(), fim: z.string(), responsavel: z.string()
});
const saidaReserva = z.object({
    reserva: z.string().nullable(), reservado: z.boolean(), sala: z.string().nullable(),
    inicio: z.string().nullable(), fim: z.string().nullable(), responsavel: z.string().nullable(),
    politica: z.string().nullable(), motivo: z.string().nullable()
});
const saidaSala = z.object({
    id: z.string(), nome: z.string(), capacidade: z.number().int(), recursos: z.array(z.string())
});

async function reservarSala(args, ctx) {
    // O requestState (ja verificado pelo hook do servidor) manda: os argumentos do retry nao sao confiaveis.
    const selado = ctx.mcpReq.requestState();
    const pedido = selado?.pedido ?? args;
    const { sala, ini, fim } = validar(pedido);

    if (selado) {
        const resp = inputResponse(ctx.mcpReq.inputResponses, CHAVE_ELICITACAO);
        if (resp.kind === 'elicit' && resp.action !== 'accept') return recusada('recusado');
        const escolha = resp.kind === 'elicit' ? resp.content?.sala : undefined;
        if (selado.alternativas.includes(escolha)) {
            validar({ ...pedido, sala: escolha });
            if (conflitos(escolha, ini, fim).length) throw new ErroDeRegra(MSG.semAlternativa);
            return concluida(criarReserva({ ...pedido, sala: escolha }));
        }
        // sem resposta valida: pergunta de novo, abaixo
    }

    if (!conflitos(sala.id, ini, fim).length) return concluida(criarReserva(pedido));

    const alts = alternativas(sala, ini, fim);
    if (!alts.length) throw new ErroDeRegra(MSG.semAlternativa);

    // Sem a capability de elicitation form, o proprio SDK recusa este inputRequired com -32021.
    const campo = alts.length === 1 ? { const: alts[0] } : { enum: alts };
    return inputRequired({
        inputRequests: {
            [CHAVE_ELICITACAO]: inputRequired.elicit({
                message: 'A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.',
                requestedSchema: {
                    type: 'object',
                    properties: { sala: { type: 'string', title: 'Sala', description: 'Sala alternativa escolhida', ...campo } },
                    required: ['sala']
                }
            })
        },
        requestState: await codec.mint({ pedido, alternativas: alts }, ctx)
    });
}

function criarServidor() {
    const server = new McpServer(
        { name: 'central-de-salas', version: '1.0.0' },
        { capabilities: { tools: {}, resources: {} }, requestState: { verify: verificarEstado } }
    );

    server.registerTool('listar_salas', {
        description: 'Lista todas as salas com capacidade e recursos.',
        inputSchema: z.object({}),
        outputSchema: z.object({ salas: z.array(saidaSala) })
    }, () => resposta({ salas }));

    server.registerTool('consultar_disponibilidade', {
        description: 'Informa se a sala esta livre no intervalo e, se nao, quais reservas conflitam.',
        inputSchema: z.object({ sala: z.string(), inicio: z.string(), fim: z.string() }),
        outputSchema: z.object({
            sala: z.string(), inicio: z.string(), fim: z.string(), livre: z.boolean(),
            conflitos: z.array(z.object({ id: z.string(), sala: z.string(), inicio: z.string(), fim: z.string(), responsavel: z.string() }))
        })
    }, comRegras(args => {
        const { ini, fim } = validar(args);
        const c = conflitos(args.sala, ini, fim);
        return resposta({ sala: args.sala, inicio: args.inicio, fim: args.fim, livre: c.length === 0, conflitos: c });
    }));

    server.registerTool('reservar_sala', {
        description: 'Reserva a sala no intervalo. Se estiver ocupada, pede ao cliente a escolha de uma sala alternativa.',
        inputSchema: argsReserva,
        outputSchema: saidaReserva
    }, comRegras(reservarSala));

    server.registerResource('politica-de-uso', 'politica://uso', {
        description: 'Politica de uso das salas', mimeType: 'text/markdown'
    }, uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: politicaTexto }] }));

    return server;
}

// ---------- HTTP ----------

const handler = createMcpHandler(criarServidor, {
    legacy: 'reject',
    responseMode: 'json',
    onerror: e => console.error(`[erro] ${e.message}`)
});

createServer(async (req, res) => {
    const corpoBruto = await new Promise(ok => {
        const partes = [];
        req.on('data', c => partes.push(c));
        req.on('end', () => ok(Buffer.concat(partes)));
    });
    let parsed;
    try {
        parsed = JSON.parse(corpoBruto.toString() || 'null');
    } catch { /* o handler responde o erro de parse */ }
    if (parsed?.method) {
        console.error(`[mcp] metodo=${parsed.method} id=${JSON.stringify(parsed.id)} traceparent=${parsed.params?._meta?.traceparent ?? '-'}`);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, [v].flat().join(', '));
    const temCorpo = req.method !== 'GET' && req.method !== 'HEAD';
    const r = await handler.fetch(new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method, headers, body: temCorpo ? corpoBruto : undefined
    }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORTA, () => console.error(`[mcp] servidor MCP em http://localhost:${PORTA}/mcp`));
