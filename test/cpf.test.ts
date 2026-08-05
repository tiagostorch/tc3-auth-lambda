import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpfValido, formatarCpf, normalizarCpf } from '../src/cpf.ts';

describe('normalizarCpf', () => {
  it('remove pontuacao', () => {
    assert.equal(normalizarCpf('529.982.247-25'), '52998224725');
  });

  it('tolera entrada vazia', () => {
    assert.equal(normalizarCpf(''), '');
  });
});

describe('cpfValido', () => {
  it('aceita CPF com digitos verificadores corretos', () => {
    assert.equal(cpfValido('529.982.247-25'), true);
    assert.equal(cpfValido('52998224725'), true);
  });

  it('recusa CPF com digito verificador errado', () => {
    assert.equal(cpfValido('529.982.247-26'), false);
  });

  it('recusa sequencias repetidas', () => {
    assert.equal(cpfValido('111.111.111-11'), false);
    assert.equal(cpfValido('00000000000'), false);
  });

  it('recusa tamanho invalido', () => {
    assert.equal(cpfValido('12345'), false);
    assert.equal(cpfValido(''), false);
  });
});

describe('formatarCpf', () => {
  it('aplica a mascara', () => {
    assert.equal(formatarCpf('52998224725'), '529.982.247-25');
  });
});
