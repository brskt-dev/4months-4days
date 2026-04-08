let shutdownRequested = false;
let shutdownSignal: NodeJS.Signals | null = null;
let handlersInstalled = false;

function requestShutdown(signal: NodeJS.Signals): void {
  if (shutdownRequested) {
    console.warn(
      `Segundo ${signal} recebido. Encerrando imediatamente sem aguardar o shutdown gracioso.`
    );
    process.exit(130);
  }

  shutdownRequested = true;
  shutdownSignal = signal;
  console.warn(
    `${signal} recebido. Iniciando shutdown gracioso: nenhum novo trabalho sera iniciado e os workers em andamento serao aguardados.`
  );
}

export function installShutdownHandlers(): void {
  if (handlersInstalled) {
    return;
  }

  handlersInstalled = true;
  process.on("SIGINT", () => requestShutdown("SIGINT"));
  process.on("SIGTERM", () => requestShutdown("SIGTERM"));
}

export function isShutdownRequested(): boolean {
  return shutdownRequested;
}

export function getShutdownSignal(): NodeJS.Signals | null {
  return shutdownSignal;
}
