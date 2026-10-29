# A Ponte: agente A2A com MCP por dentro

Hill Valley Tech: cinco salas de reuniao e dois processos.

- **Servidor MCP** (`servidor-mcp/`, porta **7301**, Streamable HTTP em `/mcp`): 3 tools, 1 resource e o ciclo MRTR da reserva.
- **Agente** (`agente/`, porta **7300**, JSON-RPC em `/a2a`): host MCP por dentro, servidor A2A por fora. Sem LLM.

Stack: Node.js 20+ (ESM, sem build), `@modelcontextprotocol/server` **2.4.0** (revisao MCP 2026-07-28) e A2A v1.0 JSON-RPC. O agente nao tem dependencias: fala com o servidor MCP por HTTP puro.

## Como rodar

A partir de um clone limpo (Node 20+ e Python 3.10+ no PATH; no Windows use `py` no lugar de `python3`):

```bash
# uma vez: dependencias do servidor MCP (o agente nao tem)
(cd servidor-mcp && npm ci)

# terminal 1: servidor MCP (o stderr traz metodo, id e traceparent de cada request)
# o segredo de integridade do requestState (>= 32 bytes) precisa estar exportado NESTE terminal;
# gere o seu e nunca o commite
export REQUEST_STATE_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
cd servidor-mcp && node src/index.js

# terminal 2: agente (nao precisa do segredo)
cd agente && node src/index.js

# terminal 3: validador, a partir da raiz do repositorio
python3 validador/validar.py --agente http://localhost:7300 --mcp http://localhost:7301
```

O servidor MCP recusa subir sem `REQUEST_STATE_SECRET` (ou com menos de 32 bytes). Se for reiniciar, reexporte o **mesmo** valor: e ele que mantem valido um `requestState` emitido antes do restart. As reservas ficam em memoria, entao rode o validador com os dois processos recem-iniciados.

Variaveis opcionais: `MCP_PORT` (7301), `AGENTE_PORT` (7300), `AGENTE_URL` (URL publica do agente no card, padrao `http://localhost:7300`), `MCP_URL` (padrao `http://localhost:7301/mcp`), `DADOS_DIR`.

## Onde a ponte acontece

Tudo em [agente/src/index.js](agente/src/index.js). O agente chama `reservar_sala` e recebe o `resultType: "input_required"` **cru** (por isso o cliente MCP e HTTP puro: o cliente do SDK com callback de elicitation responderia sozinho e a Task nunca pausaria). Em `aplicarResultado` (linha ~92) esse resultado vira `TASK_STATE_INPUT_REQUIRED`: a mensagem da Task e exatamente `alternativas: <ids na ordem do enum>`, e a chave do `inputRequests` e o `requestState` sao guardados no mapa `pausas`, indexado pelo id da Task (linha ~97). Esse mapa nunca e serializado para o cliente A2A; `publica()` so devolve id, contextId, status, history e artifacts.

A volta esta em `continuar` (linha ~141): o `SendMessage` com `taskId` e `escolha=<id>` e traduzido em `inputResponses` (`accept` com a sala, ou `decline` para `recusar`), e o agente repete o `tools/call` original com **id de JSON-RPC novo** (contador monotonico em `mcp()`), a mesma chave do `inputRequests` e o `requestState` ecoado byte a byte, sem abrir nem interpretar. Como o estado e por Task, duas Tasks pausadas ao mesmo tempo nao se misturam. O agente nao implementa regra de sala: conflito, politica e alternativas sao do servidor.

No servidor, [servidor-mcp/src/index.js](servidor-mcp/src/index.js) emite o `input_required` em `reservarSala` (linha ~124) e o `requestState` selado volta a ele pelo hook `requestState.verify` antes do handler rodar.

## Decisoes tecnicas

- **Protecao do `requestState`:** HMAC-SHA256 pelo `createRequestStateCodec` do SDK (assinado, nao cifrado: o conteudo e legivel, nao adulteravel). Chave vem so de `REQUEST_STATE_SECRET` (>= 32 bytes, validado na subida). O hook de verificacao exige tambem a forma canonica do base64url: trocar o ultimo caractere por um "irmao" decodificaria para os mesmos bytes e passaria na assinatura, entao qualquer troca de caractere e rejeitada. Adulterado ou expirado vira `-32602` ("Invalid or expired requestState") antes de o handler executar.
- **Validade:** 10 minutos (a spec pede entre 5 e 30), fixo no codigo.
- **Servidor sem estado entre as rodadas:** o `requestState` carrega o pedido original e as alternativas calculadas; o retry reconstroi tudo a partir dele. Os argumentos reenviados no retry sao ignorados (vale o selado), e a sala escolhida e revalidada contra as alternativas seladas e contra os conflitos atuais. Por isso o retry funciona depois de reiniciar o servidor com a mesma chave.
- **`-32021`:** quem emite e o proprio SDK, ao ver um `inputRequired` com elicitation form para cliente que nao declarou a capability no `_meta`. O mesmo vale para `-32602`/HTTP 400 sem `protocolVersion`/`clientCapabilities` e para `-32020` com header divergente.
- **Estado das Tasks:** em memoria no agente (`Map` por id de Task), junto com o `requestState` pausado. Nao sobrevive a restart do agente (fora de escopo); o `requestState` em si sobreviveria, pois quem o valida e o servidor MCP.
- **Descoberta em runtime:** a cada Task nova o agente faz `tools/list` (confere que `reservar_sala` existe) e le `politica://uso`, extraindo a versao da 1a linha para o artifact.
- **Trace:** o `traceparent` do `SendMessage` vira o `traceparent` do `_meta` de todos os requests MCP da Task, mesmo trace-id e span-id novo, e aparece no stderr do servidor MCP.
- **Mensagens de erro de execucao:** o texto exato da tool vai para o historico da Task `TASK_STATE_FAILED`.
- **Escolhas minhas fora do documento:** pedido fora do formato fixo termina a Task em `FAILED` com uma mensagem de uso; `SendMessage` para Task inexistente devolve `-32001` e para Task terminal ou nao pausada, `-32004`; a ordem das validacoes de dominio e sala, intervalo invertido, janela, duracao.

## Saida do validador

Execucao com os dois processos recem-iniciados (`python3 validador/validar.py --agente http://localhost:7300 --mcp http://localhost:7301`, saida 0):

```
trace-id desta execucao: decd2af0b5e369263dac1ce9bf87e62b
procure esse valor no stderr do servidor MCP para conferir a propagacao do traceparent.

PASS 01 tools/list traz as tres tools
PASS 02 toda tool tem inputSchema de objeto
PASS 03 listar_salas devolve structuredContent e o mesmo JSON em texto
PASS 04 _meta sem protocolVersion devolve -32602 e HTTP 400
PASS 05 _meta sem clientCapabilities devolve -32602 e HTTP 400
PASS 06 tool inexistente e recusada, por -32602 ou por isError
PASS 07 resources/read de politica://uso devolve a politica
PASS 08 resources/read de URI inexistente devolve -32602
PASS 09 sala inexistente devolve isError com a mensagem exata
PASS 10 fora da janela devolve isError com a mensagem exata
PASS 11 duracao acima de 2h devolve isError com a mensagem exata
PASS 12 intervalo invertido devolve isError com a mensagem exata
PASS 13 conflito devolve input_required com inputRequests e requestState
PASS 14 a elicitation e form mode e oferece as alternativas na ordem certa
PASS 15 conflito sem a capability elicitation devolve -32021 e HTTP 400
PASS 16 retry com inputResponses e requestState conclui a reserva
PASS 17 requestState adulterado e rejeitado com -32602
PASS 18 argumentos adulterados no retry nao tomam efeito
PASS 19 recusa conclui sem reservar e sem isError
PASS 20 conflito sem alternativa possivel devolve isError com a mensagem exata

PASS 21 agent card responde 200 no well-known com JSON
PASS 22 o card declara a interface JSON-RPC com url e versao 1.0
PASS 23 o card declara a skill reservar-sala
PASS 24 SendMessage com sala livre conclui a Task
PASS 25 o artifact chama reserva e traz a versao da politica
PASS 26 GetTask devolve id, contextId e estado corrente
PASS 27 SendMessage com sala ocupada pausa a Task
PASS 28 a Task pausada lista as alternativas na ordem certa
PASS 29 escolha fora do enum mantem a Task pausada
PASS 30 a continuacao conclui a Task na sala escolhida
PASS 31 SendMessage em Task terminal e recusado
PASS 32 a recusa termina a Task em CANCELED
PASS 33 duas Tasks pausadas ao mesmo tempo concluem cada uma com a sua reserva
PASS 34 nenhuma resposta A2A carrega o requestState
PASS 35 sala inexistente termina a Task em FAILED com a mensagem da tool
PASS 36 o agente e deterministico: o mesmo pedido produz a mesma pausa

resumo: 36 passaram, 0 falharam, de 36 verificacoes
```
