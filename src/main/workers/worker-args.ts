/** Reads a required `--name=value` argument of a worker process. */
export function workerArgument(argv: readonly string[], name: string): string {
  const prefix = `--${name}=`;
  const value = argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`Worker started without ${prefix}`);
  return value;
}
