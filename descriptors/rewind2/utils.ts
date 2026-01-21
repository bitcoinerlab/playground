export const isWeb = typeof window !== 'undefined';

export const Log = (message: string) => {
  const logsElement = isWeb && document.getElementById('logs');
  if (logsElement) {
    logsElement.innerHTML += `<p>${message}</p>`;
    logsElement?.lastElementChild?.scrollIntoView();
  }
  console.log(message.replace(/<[^>]*>?/gm, '')); //strip html tags
};

//JSON to pretty-string format:
export const JSONf = (json: object) => JSON.stringify(json, null, '\t');

export const wait = (ms: number) =>
  new Promise(resolve => setTimeout(resolve, ms));

export const formatExplorerLink = (label: string, href: string) =>
  isWeb
    ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : label === href
      ? href
      : `${label} - ${href}`;

export const createExplorerLinks = (baseUrl: string) => ({
  explorerTxLink: (txId: string) =>
    formatExplorerLink(txId, `${baseUrl}/tx/${txId}`),
  explorerAddressLink: (address: string) =>
    formatExplorerLink(address, `${baseUrl}/address/${address}`),
  explorerBaseLink: () => formatExplorerLink(baseUrl, baseUrl)
});

const promptNode = (question: string) =>
  new Promise<string>(resolve => {
    process.stdout.write(question);
    process.stdin.resume();
    process.stdin.once('data', data => {
      process.stdin.pause();
      resolve(String(data).trim());
    });
  });

export const parseChoice = <T extends string>(
  choice: string,
  options: readonly T[],
  fallback: T
): T => {
  if (options.includes(choice as T)) return choice as T;
  const index = Number(choice);
  if (Number.isInteger(index) && index >= 1 && index <= options.length)
    return options[index - 1] ?? fallback;
  return fallback;
};

export const pickChoice = async <T extends string>(
  options: readonly T[],
  fallback: T,
  promptLabel: string,
  selectId: string
): Promise<T> => {
  if (isWeb) {
    const select = document.getElementById(
      selectId
    ) as HTMLSelectElement | null;
    const value = select?.value ?? '';
    return parseChoice(value, options, fallback);
  }

  const defaultIndex = Math.max(options.indexOf(fallback), 0);
  const optionsText = options
    .map((option, index) => `${index + 1}=${option}`)
    .join(', ');
  const answer = await promptNode(
    `${promptLabel} (${optionsText}) [${defaultIndex + 1}]: `
  );
  const normalized = answer || String(defaultIndex + 1);
  return parseChoice(normalized, options, fallback);
};

export const shouldRestartNode = async () => {
  const answer = await promptNode(
    'Run again with different backup type? (y/N): '
  );
  return answer.toLowerCase().startsWith('y');
};

type RenderWebControlsOptions<T extends string> = {
  options: readonly T[];
  defaultOption: T;
  onRun: () => Promise<void>;
  onPushTrigger?: () => Promise<boolean | void>;
  onPushPanic?: () => Promise<boolean | void>;
  selectId?: string;
  startLabel?: string;
  restartLabel?: string;
  pushTriggerLabel?: string;
  pushPanicLabel?: string;
};

export const renderWebControls = <T extends string>({
  options,
  defaultOption,
  onRun,
  onPushTrigger,
  onPushPanic,
  selectId = 'backup-type',
  startLabel = 'Start playground',
  restartLabel = 'Restart',
  pushTriggerLabel = 'Push trigger/unvault',
  pushPanicLabel = 'Push panic'
}: RenderWebControlsOptions<T>) => {
  document.body.style.marginBottom = '60px'; //prevent CodeSandbox UI from overlapping the logs
  const renderStartControls = () => `
 <div id="start-controls" style="font-family: monospace; margin-bottom: 12px;">
   <label for="${selectId}">Backup type:</label>
   <select id="${selectId}" style="margin-left: 8px;">
     ${options
       .map(
         option =>
           `<option value="${option}" ${
             option === defaultOption ? 'selected' : ''
           }>${option}</option>`
       )
       .join('')}
   </select>
   <button id="start">${startLabel}</button>
 </div>
 `;
  const renderActionControls = () => `
 <div id="action-controls" style="font-family: monospace; margin-bottom: 12px; display: none;">
   ${
     onPushTrigger
       ? `<button id="push-trigger" disabled>${pushTriggerLabel}</button>`
       : ''
   }
   ${
     onPushPanic
       ? `<button id="push-panic" style="margin-left: 6px;" disabled>${pushPanicLabel}</button>`
       : ''
   }
   <button id="restart" style="margin-left: 6px;" disabled>${restartLabel}</button>
 </div>
 `;
  document.body.innerHTML = `
 <div id="logs" style="white-space: pre-wrap;font-family: monospace;"></div>
${renderStartControls()}
${renderActionControls()}
 `;
  const startControls = document.getElementById('start-controls');
  const actionControls = document.getElementById('action-controls');
  const startButton = document.getElementById(
    'start'
  ) as HTMLButtonElement | null;
  const restartButton = document.getElementById(
    'restart'
  ) as HTMLButtonElement | null;
  const pushTriggerButton = document.getElementById(
    'push-trigger'
  ) as HTMLButtonElement | null;
  const pushPanicButton = document.getElementById(
    'push-panic'
  ) as HTMLButtonElement | null;
  const run = async () => {
    const logs = document.getElementById('logs');
    if (logs) logs.innerHTML = '';
    if (startControls) startControls.style.display = 'none';
    if (actionControls) actionControls.style.display = '';
    if (startButton) startButton.disabled = true;
    if (restartButton) restartButton.disabled = true;
    if (pushTriggerButton) pushTriggerButton.disabled = true;
    if (pushPanicButton) pushPanicButton.disabled = true;
    let runSucceeded = false;
    try {
      await onRun();
      runSucceeded = true;
    } finally {
      if (runSucceeded) {
        if (restartButton) restartButton.disabled = false;
        if (pushTriggerButton) pushTriggerButton.disabled = false;
        if (pushPanicButton) pushPanicButton.disabled = true;
      } else {
        if (actionControls) actionControls.style.display = 'none';
        if (startControls) startControls.style.display = '';
        if (startButton) startButton.disabled = false;
      }
    }
  };
  startButton?.addEventListener('click', () => {
    void run();
  });
  restartButton?.addEventListener('click', () => {
    void run();
  });
  pushTriggerButton?.addEventListener('click', () => {
    void (async () => {
      if (!onPushTrigger || !pushTriggerButton) return;
      pushTriggerButton.disabled = true;
      if (pushPanicButton) pushPanicButton.disabled = true;
      try {
        const result = await onPushTrigger();
        if (result === false) {
          pushTriggerButton.disabled = false;
          return;
        }
        if (pushTriggerButton) pushTriggerButton.style.display = 'none';
        if (pushPanicButton) pushPanicButton.disabled = false;
      } catch {
        pushTriggerButton.disabled = false;
      }
    })();
  });
  pushPanicButton?.addEventListener('click', () => {
    void (async () => {
      if (!onPushPanic || !pushPanicButton) return;
      pushPanicButton.disabled = true;
      try {
        const result = await onPushPanic();
        if (result === false) {
          pushPanicButton.disabled = false;
          return;
        }
        pushPanicButton.style.display = 'none';
      } catch {
        pushPanicButton.disabled = false;
      }
    })();
  });
};

export const promptNodeChoice = async <T extends string>({
  options,
  fallback,
  promptLabel
}: {
  options: readonly T[];
  fallback: T;
  promptLabel: string;
}): Promise<T> => {
  if (isWeb) return fallback;
  const defaultIndex = Math.max(options.indexOf(fallback), 0);
  const optionsText = options
    .map((option, index) => `${index + 1}=${option}`)
    .join(', ');
  const answer = await promptNode(
    `${promptLabel} (${optionsText}) [${defaultIndex + 1}]: `
  );
  const normalized = answer || String(defaultIndex + 1);
  return parseChoice(normalized, options, fallback);
};
