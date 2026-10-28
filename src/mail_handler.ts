import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import nodemailer from 'nodemailer';
import { timingSafeEqual } from 'node:crypto';
import { memoizarSemFalha } from './memoizar.ts';

interface EventoHttp {
  body?: string | null;
  headers?: Record<string, string | undefined>;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string } };
}

interface Resposta {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

interface ConfiguracaoMail {
  host: string;
  port: number;
  user: string;
  pass: string;
  apiToken: string;
}

/**
 * Imagem embutida no e-mail. Com `cid`, o HTML a mostra com `<img src="cid:...">`
 * (ex.: o QR Code de pagamento do Billing); sem ele, vai como anexo comum.
 */
export interface Anexo {
  filename: string;
  contentType: string;
  /** Conteúdo em base64. */
  content: string;
  cid?: string;
}

interface Email {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Anexo[];
}

export interface MailTransport {
  sendMail(message: {
    from: string; to: string; subject: string; text: string; html?: string;
    attachments?: (Anexo & { encoding: 'base64' })[];
  }): Promise<unknown>;
}

export interface DependenciasMailHandler {
  obterConfiguracao: () => Promise<ConfiguracaoMail>;
  criarTransport: (configuracao: ConfiguracaoMail) => MailTransport;
}

const ssm = new SSMClient({});
let configuracaoEmCache: Promise<ConfiguracaoMail> | undefined;

function responder(statusCode: number, corpo: unknown, correlationId: string): Resposta {
  return { statusCode, headers: { 'content-type': 'application/json', 'x-correlation-id': correlationId }, body: JSON.stringify(corpo) };
}

function log(nivel: 'info' | 'warn' | 'error', mensagem: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ nivel, mensagem, servico: 'mail-lambda', timestamp: new Date().toISOString(), ...extra }));
}

async function obterConfiguracaoSsm(): Promise<ConfiguracaoMail> {
  const prefixo = process.env.MAIL_SSM_PREFIX;
  if (!prefixo) throw new Error('MAIL_SSM_PREFIX ausente');
  const nomes = ['MAIL_HOST', 'MAIL_PORT', 'MAIL_USER', 'MAIL_PASS', 'MAIL_API_TOKEN'];
  const resultado = await ssm.send(new GetParametersCommand({
    Names: nomes.map((nome) => `${prefixo}/${nome}`), WithDecryption: true,
  }));
  const valores = new Map(resultado.Parameters?.map((p) => [p.Name?.split('/').at(-1), p.Value]) ?? []);
  const ausentes = nomes.filter((nome) => !valores.get(nome));
  if (ausentes.length > 0) throw new Error(`Parametros SSM ausentes: ${ausentes.join(', ')}`);
  const port = Number(valores.get('MAIL_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MAIL_PORT invalida');
  return { host: valores.get('MAIL_HOST')!, port, user: valores.get('MAIL_USER')!, pass: valores.get('MAIL_PASS')!, apiToken: valores.get('MAIL_API_TOKEN')! };
}

const obterConfiguracao = memoizarSemFalha(obterConfiguracaoSsm);

function criarTransport(configuracao: ConfiguracaoMail): MailTransport {
  return nodemailer.createTransport({
    host: configuracao.host, port: configuracao.port, secure: configuracao.port === 465,
    auth: { user: configuracao.user, pass: configuracao.pass },
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
  });
}

function tokenValido(informado: string | undefined, esperado: string): boolean {
  if (!informado) return false;
  const tokenInformado = Buffer.from(informado);
  const tokenEsperado = Buffer.from(esperado);
  return tokenInformado.length === tokenEsperado.length && timingSafeEqual(tokenInformado, tokenEsperado);
}

// Só imagens, poucas e pequenas: a rota existe para avisos ao cliente, não para
// transportar arquivos. O API Gateway aceita até 10 MB por requisição.
export const TIPOS_DE_ANEXO = ['image/png', 'image/jpeg'];
export const MAXIMO_DE_ANEXOS = 3;
export const TAMANHO_MAXIMO_DO_ANEXO = 512 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const CID = /^[A-Za-z0-9._@-]{1,100}$/;

function textoPreenchido(valor: unknown): valor is string {
  return typeof valor === 'string' && valor.trim().length > 0;
}

function anexoValido(anexo: unknown): anexo is Anexo {
  if (!anexo || typeof anexo !== 'object') return false;
  const { filename, contentType, content, cid } = anexo as Record<string, unknown>;
  return textoPreenchido(filename) && filename.length <= 100
    && typeof contentType === 'string' && TIPOS_DE_ANEXO.includes(contentType)
    && typeof content === 'string' && content.length % 4 === 0 && BASE64.test(content)
    && Buffer.byteLength(content, 'base64') <= TAMANHO_MAXIMO_DO_ANEXO
    && (cid === undefined || (typeof cid === 'string' && CID.test(cid)));
}

function corpoValido(corpo: unknown): corpo is Email {
  if (!corpo || typeof corpo !== 'object') return false;
  const email = corpo as Record<string, unknown>;
  if (!['to', 'subject', 'text'].every((campo) => textoPreenchido(email[campo]))) return false;
  if (email.html !== undefined && !textoPreenchido(email.html)) return false;
  if (email.attachments === undefined) return true;
  return Array.isArray(email.attachments) && email.attachments.length <= MAXIMO_DE_ANEXOS && email.attachments.every(anexoValido);
}

const dependenciasPadrao: DependenciasMailHandler = { obterConfiguracao, criarTransport };

export function criarMailHandler(dependencias = dependenciasPadrao) {
  return async function handler(evento: EventoHttp, contexto: { awsRequestId: string }): Promise<Resposta> {
    const correlationId = contexto?.awsRequestId ?? 'sem-correlacao';
    if (evento.requestContext?.http?.method && evento.requestContext.http.method !== 'POST') {
      return responder(405, { mensagem: 'Metodo nao permitido.' }, correlationId);
    }
    let configuracao: ConfiguracaoMail;
    try {
      configuracao = await dependencias.obterConfiguracao();
    } catch (erro) {
      log('error', 'Falha ao obter configuracao de email', { correlationId, erro: erro instanceof Error ? erro.message : String(erro) });
      return responder(500, { mensagem: 'Erro ao configurar email.' }, correlationId);
    }
    const headerToken = evento.headers?.['x-mail-api-token'] ?? evento.headers?.['X-Mail-Api-Token'];
    if (!tokenValido(headerToken, configuracao.apiToken)) {
      log('warn', 'Token de chamada de email invalido', { correlationId });
      return responder(401, { mensagem: 'Nao autorizado.' }, correlationId);
    }
    let corpo: unknown;
    try {
      const bruto = evento.isBase64Encoded && evento.body ? Buffer.from(evento.body, 'base64').toString('utf8') : evento.body;
      corpo = JSON.parse(bruto ?? '{}');
    } catch {
      return responder(400, { mensagem: 'Corpo da requisicao invalido.' }, correlationId);
    }
    if (!corpoValido(corpo)) {
      return responder(400, {
        mensagem: `Campos to, subject e text sao obrigatorios; html e opcional; attachments aceita ate ${MAXIMO_DE_ANEXOS} imagens (${TIPOS_DE_ANEXO.join(', ')}) em base64, de ate ${TAMANHO_MAXIMO_DO_ANEXO / 1024} KB cada.`,
      }, correlationId);
    }
    try {
      await dependencias.criarTransport(configuracao).sendMail({
        from: process.env.MAIL_FROM ?? '"Oficina SOAT" <noreply@oficina.com>', to: corpo.to, subject: corpo.subject, text: corpo.text,
        // Só os campos validados: o nodemailer também aceita `path` e `href` num
        // anexo (ler arquivo local, buscar URL), e isso não pode vir de fora.
        html: corpo.html, attachments: corpo.attachments?.map(({ filename, contentType, content, cid }) => ({ filename, contentType, content, cid, encoding: 'base64' as const })),
      });
    } catch (erro) {
      log('error', 'Falha ao enviar email', { correlationId, erro: erro instanceof Error ? erro.message : String(erro) });
      return responder(500, { mensagem: 'Erro ao enviar email.' }, correlationId);
    }
    log('info', 'Email emitido', { correlationId, target: corpo.to, anexos: corpo.attachments?.length ?? 0 });
    return responder(200, { message: 'Email enviado com sucesso.' }, correlationId);
  };
}

export const handler = criarMailHandler();
