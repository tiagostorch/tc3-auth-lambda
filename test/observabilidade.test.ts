import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cabecalho,
  correlationIdSeguro,
  marcarInvocacao,
  metadadosDeTrace,
  redefinirAgenteParaTestes,
  tagsDeObservabilidade,
  traceparentValido,
  traceresponseAtual,
} from '../src/observabilidade.ts';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('tagsDeObservabilidade', () => {
  it('lê o mesmo formato de NEW_RELIC_LABELS da API', () => {
    assert.deepEqual(tagsDeObservabilidade('environment:production;project:tech-challenge-fiap'), {
      environment: 'production',
      project: 'tech-challenge-fiap',
    });
  });

  it('ignora pares malformados e variável ausente', () => {
    assert.deepEqual(tagsDeObservabilidade('semvalor:;:x;solto;ok:1'), { ok: '1' });
    assert.deepEqual(tagsDeObservabilidade(undefined), {});
  });
});

describe('traceparentValido (W3C Trace Context)', () => {
  it('aceita o formato versão 00', () => {
    assert.equal(traceparentValido(TRACEPARENT), TRACEPARENT);
  });

  it('rejeita trace-id ou parent-id nulos, maiúsculas e lixo', () => {
    assert.equal(traceparentValido('00-00000000000000000000000000000000-00f067aa0ba902b7-01'), undefined);
    assert.equal(traceparentValido('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01'), undefined);
    assert.equal(traceparentValido(TRACEPARENT.toUpperCase()), undefined);
    assert.equal(traceparentValido('qualquer-coisa'), undefined);
    assert.equal(traceparentValido(undefined), undefined);
  });
});

describe('cabecalho', () => {
  it('encontra o cabeçalho sem depender da caixa', () => {
    assert.equal(cabecalho({ 'X-Correlation-Id': 'abc' }, 'x-correlation-id'), 'abc');
    assert.equal(cabecalho({ traceparent: TRACEPARENT }, 'TraceParent'), TRACEPARENT);
  });

  it('tolera evento sem cabeçalhos', () => {
    assert.equal(cabecalho(undefined, 'x'), undefined);
    assert.equal(cabecalho(null, 'x'), undefined);
  });
});

describe('correlationIdSeguro', () => {
  it('aceita ids comuns', () => {
    assert.equal(correlationIdSeguro('7d2f1c3e-9a1c-4f70-8b2d-0e1f2a3b4c5d'), '7d2f1c3e-9a1c-4f70-8b2d-0e1f2a3b4c5d');
  });

  it('descarta valor longo demais ou com caracteres fora de id', () => {
    assert.equal(correlationIdSeguro('a'.repeat(129)), undefined);
    assert.equal(correlationIdSeguro('id com espaço'), undefined);
    assert.equal(correlationIdSeguro('{"injetado":true}'), undefined);
  });
});

describe('integração com o agente', () => {
  afterEach(() => redefinirAgenteParaTestes(undefined));

  it('sem agente (fora do Lambda) tudo vira no-op', () => {
    redefinirAgenteParaTestes(null);

    assert.deepEqual(metadadosDeTrace(), {});
    assert.equal(traceresponseAtual(), undefined);
    assert.doesNotThrow(() => marcarInvocacao({ environment: 'production' }));
  });

  it('traceresponse devolve o traceparent que o agente gera para a invocação', () => {
    redefinirAgenteParaTestes({
      getTransaction: () => ({
        insertDistributedTraceHeaders: (cabecalhos: Record<string, string>) => {
          cabecalhos.traceparent = TRACEPARENT;
          cabecalhos.tracestate = '123@nr=0-0-1-2-3-4-5-6-7';
        },
      }),
    });

    assert.equal(traceresponseAtual(), TRACEPARENT);
  });

  it('traceresponse omitido se o agente produzir valor fora do padrão', () => {
    redefinirAgenteParaTestes({
      getTransaction: () => ({
        insertDistributedTraceHeaders: (cabecalhos: Record<string, string>) => {
          cabecalhos.traceparent = 'invalido';
        },
      }),
    });

    assert.equal(traceresponseAtual(), undefined);
  });

  it('pede metadados sem supportability e repassa atributos da invocação', () => {
    const chamadas: unknown[] = [];

    redefinirAgenteParaTestes({
      getLinkingMetadata: (omitir) => {
        chamadas.push(['getLinkingMetadata', omitir]);
        return { 'trace.id': '4bf92f3577b34da6a3ce929d0e0e4736' };
      },
      addCustomAttributes: (atributos) => chamadas.push(['addCustomAttributes', atributos]),
    });

    assert.deepEqual(metadadosDeTrace(), { 'trace.id': '4bf92f3577b34da6a3ce929d0e0e4736' });
    marcarInvocacao({ environment: 'production', correlationId: 'abc' });

    assert.deepEqual(chamadas, [
      ['getLinkingMetadata', true],
      ['addCustomAttributes', { environment: 'production', correlationId: 'abc' }],
    ]);
  });

  it('exceção do agente não derruba a autenticação', () => {
    redefinirAgenteParaTestes({
      getLinkingMetadata: () => {
        throw new Error('agente quebrado');
      },
      addCustomAttributes: () => {
        throw new Error('agente quebrado');
      },
      getTransaction: () => {
        throw new Error('agente quebrado');
      },
    });

    assert.deepEqual(metadadosDeTrace(), {});
    assert.doesNotThrow(() => marcarInvocacao({ a: 'b' }));
    assert.equal(traceresponseAtual(), undefined);
  });
});
