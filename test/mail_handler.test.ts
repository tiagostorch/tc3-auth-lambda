import test from 'node:test';
import assert from 'node:assert/strict';
import { criarMailHandler, TAMANHO_MAXIMO_DO_ANEXO, type DependenciasMailHandler, type MailTransport } from '../src/mail_handler.ts';
import { memoizarSemFalha } from '../src/memoizar.ts';

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

const png = Buffer.from('imagem-png').toString('base64');
const qrCode = { filename: 'qrcode.png', contentType: 'image/png', content: png, cid: 'qrcode-pagamento' };
const comAnexos = (attachments: unknown, extra: Record<string, unknown> = {}) =>
  evento({ to: 'a@b.com', subject: 'Pagamento', text: 'Olá', html: '<img src="cid:qrcode-pagamento">', attachments, ...extra });

test('envia HTML com imagem embutida pelo cid', async () => {
  const enviados: Parameters<MailTransport['sendMail']>[0][] = [];
  const h = handler({ criarTransport: () => ({ sendMail: async (mensagem) => { enviados.push(mensagem); } }) });
  assert.equal((await h(comAnexos([qrCode]), contexto)).statusCode, 200);
  assert.equal(enviados[0].html, '<img src="cid:qrcode-pagamento">');
  assert.deepEqual(enviados[0].attachments, [{ ...qrCode, encoding: 'base64' }]);
});
test('campos extras do anexo (path, href) não chegam ao transporte', async () => {
  const enviados: Parameters<MailTransport['sendMail']>[0][] = [];
  const h = handler({ criarTransport: () => ({ sendMail: async (mensagem) => { enviados.push(mensagem); } }) });
  assert.equal((await h(comAnexos([{ ...qrCode, path: '/etc/passwd', href: 'http://169.254.169.254/' }]), contexto)).statusCode, 200);
  assert.deepEqual(enviados[0].attachments, [{ ...qrCode, encoding: 'base64' }]);
});
test('e-mail só com texto continua sem html nem anexos', async () => {
  const enviados: Parameters<MailTransport['sendMail']>[0][] = [];
  const h = handler({ criarTransport: () => ({ sendMail: async (mensagem) => { enviados.push(mensagem); } }) });
  assert.equal((await h(evento({ to: 'a@b.com', subject: 'Teste', text: 'Olá' }), contexto)).statusCode, 200);
  assert.equal(enviados[0].html, undefined);
  assert.equal(enviados[0].attachments, undefined);
});
test('rejeita html vazio e anexos fora do formato', async () => {
  const h = handler();
  const casos: [string, unknown, Record<string, unknown>?][] = [
    ['html vazio', [qrCode], { html: ' ' }],
    ['attachments não é lista', qrCode],
    ['mais de 3 anexos', [qrCode, qrCode, qrCode, qrCode]],
    ['tipo que não é imagem', [{ ...qrCode, contentType: 'application/pdf' }]],
    ['base64 inválido', [{ ...qrCode, content: 'não é base64!' }]],
    ['cid com caractere proibido', [{ ...qrCode, cid: 'qr code<script>' }]],
    ['sem nome de arquivo', [{ ...qrCode, filename: '' }]],
    ['anexo grande demais', [{ ...qrCode, content: Buffer.alloc(TAMANHO_MAXIMO_DO_ANEXO + 1).toString('base64') }]],
  ];
  for (const [caso, attachments, extra] of casos) {
    assert.equal((await h(comAnexos(attachments, extra), contexto)).statusCode, 400, caso);
  }
});
test('aceita anexo sem cid e no tamanho máximo', async () => {
  const { cid: _cid, ...semCid } = qrCode;
  const noLimite = { ...semCid, content: Buffer.alloc(TAMANHO_MAXIMO_DO_ANEXO).toString('base64') };
  assert.equal((await handler()(comAnexos([noLimite]), contexto)).statusCode, 200);
});
