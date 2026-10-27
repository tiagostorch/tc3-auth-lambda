// Guarda só o sucesso. Com a falha em cache, um parâmetro ausente na primeira
// invocação deixava a instância respondendo 500 até ser reciclada, mesmo depois
// de o parâmetro ser criado no SSM.
export function memoizarSemFalha<T>(buscar: () => Promise<T>): () => Promise<T> {
  let emCache: Promise<T> | undefined;
  return () => {
    emCache ??= buscar().catch((erro: unknown) => {
      emCache = undefined;
      throw erro;
    });
    return emCache;
  };
}
