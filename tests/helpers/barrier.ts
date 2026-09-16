export function barrier() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}
