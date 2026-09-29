// Sobe um `hardhat node` local numa porta livre, só em 127.0.0.1, e devolve a URL.
// O nó imprime chaves privadas de desenvolvimento: drenamos a saída sem gravar
// nem anexar ao erro. Somente o marcador de prontidão é reconhecido.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const hardhatDir = path.resolve(here, '../../hardhat');
const bin = path.resolve(here, '../../../node_modules/.bin/hardhat');

export function artifact(name = 'DeliverProof') {
  return JSON.parse(readFileSync(path.join(hardhatDir, `artifacts/contracts/${name}.sol/${name}.json`), 'utf8'));
}

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

export async function startNode(): Promise<{ url: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const child: ChildProcess = spawn(bin, ['node', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: hardhatDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Hardhat prints development private keys. Never include its output in an error or log.
  // Drain both pipes without retaining output after the readiness marker.
  child.on('error', () => {}); // Startup/stop handlers report sanitized errors; never leave an unhandled event.
  const stop = async (): Promise<void> => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((ok, fail) => {
      let force: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        clearTimeout(grace);
        clearTimeout(force);
        child.off('exit', finish);
        ok();
      };
      const grace = setTimeout(() => {
        child.kill('SIGKILL');
        force = setTimeout(() => {
          child.off('exit', finish);
          fail(new Error('hardhat node did not terminate'));
        }, 3_000);
      }, 3_000);
      child.once('exit', finish);
      child.kill('SIGTERM');
    });
  };
  try {
    await new Promise<void>((ok, fail) => {
      let prefix = '',
        settled = false;
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        prefix = '';
        clearTimeout(timer);
        child.off('error', failed);
        child.off('exit', exited);
        if (error) fail(error);
        else ok();
      };
      const failed = () => done(new Error('hardhat node could not start'));
      const exited = () => done(new Error('hardhat node exited before readiness'));
      const timer = setTimeout(() => done(new Error('hardhat node did not start in 60s')), 60_000);
      const on = (b: Buffer) => {
        if (settled) return;
        const text = prefix + b.toString();
        if (text.includes('Started HTTP')) done();
        else prefix = text.slice(-32);
      };
      child.stdout!.on('data', on);
      child.stderr!.on('data', on);
      child.once('error', failed);
      child.once('exit', exited);
    });
  } catch (e) {
    await stop();
    throw e;
  }
  return { url: `http://127.0.0.1:${port}`, stop };
}
