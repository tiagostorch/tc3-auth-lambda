/**
 * Validação de CPF pelos dígitos verificadores (algoritmo módulo 11).
 */

export function normalizarCpf(valor: string): string {
  return (valor ?? '').replace(/\D/g, '');
}

export function cpfValido(valor: string): boolean {
  const cpf = normalizarCpf(valor);

  if (cpf.length !== 11) return false;

  // Sequências repetidas passam no cálculo dos dígitos, mas não são CPFs reais.
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const digitos = cpf.split('').map(Number);

  for (const [posicao, pesoInicial] of [
    [9, 10],
    [10, 11],
  ]) {
    let soma = 0;

    for (let i = 0; i < posicao; i++) {
      soma += digitos[i] * (pesoInicial - i);
    }

    const resto = (soma * 10) % 11;
    const esperado = resto === 10 ? 0 : resto;

    if (esperado !== digitos[posicao]) return false;
  }

  return true;
}

/** Formata como 000.000.000-00; devolve a entrada normalizada se não for CPF. */
export function formatarCpf(valor: string): string {
  const cpf = normalizarCpf(valor);

  if (cpf.length !== 11) return cpf;

  return cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}
