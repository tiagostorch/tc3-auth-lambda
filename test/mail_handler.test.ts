import test from 'node:test';
import assert from 'node:assert/strict';
import { criarMailHandler, memoizarSemFalha, type DependenciasMailHandler } from '../src/mail_handler.ts';

const configuracao = { host: 'smtp.example.com', port: 587, user: 'user', pass: 'pass', apiToken: 'segredo' };
function handler(dependencias: Partial<DependenciasMailHandler> = {}) {
  return criarMailHandler({ obterConfiguracao: async () => configuracao, criarTransport: () => ({ sendMail: async () => undefined }), ...dependencias });
}
const contexto = { awsRequestId: 'req-1' };
const evento = (body: unknown, token = 'segredo') => ({ headers: { 'x-mail-api-token': token }, requestContext: { http: { method: 'POST' } }, body: JSON.stringify(body) });

test('envia email válido', async () => assert.equal((await handler()(evento({ to: 'a@b.com', subject: 'Teste', text: 'Olá' }), contexto)).statusCode, 200));
test('rejeita token inválido', async () => assert.equal((await handler()(evento({ to: 'a@b.com', subject: 'Teste', text: 'Olá' }, 'errado'), contexto)).statusCode, 401));
test('rejeita JSON inválido e campos ausentes', async () => {
  const h = handler();
  assert.equal((await h({ headers: { 'x-mail-api-token': 'segredo' }, body: '{' }, contexto)).statusCode, 400);
  assert.equal((await h(evento({ to: 'a@b.com' }), contexto)).statusCode, 400);
});
test('aceita body em base64', async () => {
  const body = Buffer.from(JSON.stringify({ to: 'a@b.com', subject: 'Teste', text: 'Olá' })).toString('base64');
  assert.equal((await handler()({ headers: { 'x-mail-api-token': 'segredo' }, body, isBase64Encoded: true }, contexto)).statusCode, 200);
});
test('retorna 500 quando o SMTP falha', async () => {
  const resposta = await handler({ criarTransport: () => ({ sendMail: async () => { throw new Error('SMTP down'); } }) })(evento({ to: 'a@b.com', subject: 'Teste', text: 'Olá' }), contexto);
  assert.equal(resposta.statusCode, 500);
});
test('configuração: falha não fica em cache', async () => {
  let chamadas = 0;
  const obter = memoizarSemFalha(async () => { chamadas += 1; if (chamadas === 1) throw new Error('Parametros SSM ausentes'); return configuracao; });
  await assert.rejects(obter(), /ausentes/);
  assert.deepEqual(await obter(), configuracao);
  assert.equal(chamadas, 2);
});
test('configuração: sucesso fica em cache', async () => {
  let chamadas = 0;
  const obter = memoizarSemFalha(async () => { chamadas += 1; return configuracao; });
  await obter();
  await obter();
  assert.equal(chamadas, 1);
});
