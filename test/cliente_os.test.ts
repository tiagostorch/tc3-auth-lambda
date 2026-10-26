import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { criarBuscaCliente, type DependenciasBuscaCliente } from '../src/cliente_os.ts';

const cliente = { id: 'c1', nome: 'Maria', status: 'ATIVO' };

interface Chamada {
  url: string;
  init: RequestInit;
}

function jsonResponse(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });
}

// Cada chamada consome a próxima resposta (ou erro) da lista.
function buscar(respostas: Array<Response | Error>, extras: Partial<DependenciasBuscaCliente> = {}) {
  const chamadas: Chamada[] = [];
  const requisitar = async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: String(url), init: init ?? {} });
    const proxima = respostas.shift();
    if (!proxima) throw new Error('chamada inesperada');
    if (proxima instanceof Error) throw proxima;
    return proxima;
  };
  const busca = criarBuscaCliente({
    urlBase: 'https://api.exemplo',
    obterToken: async () => 'token-interno',
    requisitar,
    timeoutMs: 1_000,
    ...extras,
  });
  return { busca, chamadas };
}

describe('buscarCliente', () => {
  it('chama a rota interna com o CPF no corpo, o token e o correlationId', async () => {
    const { busca, chamadas } = buscar([jsonResponse(200, cliente)]);

    assert.deepEqual(await busca('52998224725', 'corr-1'), cliente);

    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].url, 'https://api.exemplo/internal/clientes/busca');
    assert.equal(chamadas[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(String(chamadas[0].init.body)), { cpf: '52998224725' });
    const headers = new Headers(chamadas[0].init.headers);
    assert.equal(headers.get('x-internal-token'), 'token-interno');
    assert.equal(headers.get('x-correlation-id'), 'corr-1');
    assert.ok(chamadas[0].init.signal instanceof AbortSignal);
  });

  it('aceita cliente sem status', async () => {
    const { busca } = buscar([jsonResponse(200, { ...cliente, status: null })]);
    assert.deepEqual(await busca('52998224725', 'corr'), { ...cliente, status: null });
  });

  it('devolve null quando o OS responde 404', async () => {
    const { busca } = buscar([jsonResponse(404, { message: 'Cliente não encontrado' })]);
    assert.equal(await busca('52998224725', 'corr'), null);
  });

  it('tenta de novo depois de um erro de rede ou timeout', async () => {
    const { busca, chamadas } = buscar([new Error('The operation was aborted due to timeout'), jsonResponse(200, cliente)]);
    assert.deepEqual(await busca('52998224725', 'corr'), cliente);
    assert.equal(chamadas.length, 2);
  });

  it('tenta de novo depois de um 5xx', async () => {
    const { busca, chamadas } = buscar([jsonResponse(503, {}), jsonResponse(200, cliente)]);
    assert.deepEqual(await busca('52998224725', 'corr'), cliente);
    assert.equal(chamadas.length, 2);
  });

  it('desiste depois de duas falhas seguidas', async () => {
    const { busca, chamadas } = buscar([jsonResponse(502, {}), jsonResponse(502, {})]);
    await assert.rejects(busca('52998224725', 'corr'), /respondeu 502/);
    assert.equal(chamadas.length, 2);
  });

  it('não repete um 4xx: é configuração, não instabilidade', async () => {
    const { busca, chamadas } = buscar([jsonResponse(401, { message: 'Token interno inválido' })]);
    await assert.rejects(busca('52998224725', 'corr'), /respondeu 401/);
    assert.equal(chamadas.length, 1);
  });

  it('recusa resposta fora do contrato', async () => {
    const { busca } = buscar([jsonResponse(200, { id: 'c1' })]);
    await assert.rejects(busca('52998224725', 'corr'), /fora do contrato/);
  });

  it('falha sem chamar nada quando o endereço do OS não está configurado', async () => {
    const { busca, chamadas } = buscar([], { urlBase: '' });
    await assert.rejects(busca('52998224725', 'corr'), /OS_API_URL ausente/);
    assert.equal(chamadas.length, 0);
  });
});
