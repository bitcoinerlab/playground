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
  onPushTrigger?: () => Promise<void>;
  onPushPanic?: () => Promise<void>;
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
  pushTriggerLabel = 'Push trigger',
  pushPanicLabel = 'Push panic'
}: RenderWebControlsOptions<T>) => {
  document.body.style.marginBottom = '60px'; //prevent CodeSandbox UI from overlapping the logs
  const renderActionButtons = (withSelect: boolean) => `
 <div style="font-family: monospace; margin-bottom: 12px;">
   ${
     withSelect
       ? `<label for="${selectId}">Backup type:</label>
   <select id="${selectId}" style="margin-left: 8px;">
     ${options
       .map(
         option =>
           `<option value="${option}" ${
             option === defaultOption ? 'selected' : ''
           }>${option}</option>`
       )
       .join('')}
   </select>`
       : '<span>Actions:</span>'
   }
   <button data-action="start">${startLabel}</button>
   <button data-action="restart" style="margin-left: 6px;" disabled>${restartLabel}</button>
   ${
     onPushTrigger
       ? `<button data-action="push-trigger" style="margin-left: 6px;" disabled>${pushTriggerLabel}</button>`
       : ''
   }
   ${
     onPushPanic
       ? `<button data-action="push-panic" style="margin-left: 6px;" disabled>${pushPanicLabel}</button>`
       : ''
   }
 </div>
 `;
  document.body.innerHTML = `
 <div id="logs" style="white-space: pre-wrap;font-family: monospace;"></div>
${renderActionButtons(true)}
 `;
  const startButtons = Array.from(
    document.querySelectorAll('[data-action="start"]')
  ) as HTMLButtonElement[];
  const restartButtons = Array.from(
    document.querySelectorAll('[data-action="restart"]')
  ) as HTMLButtonElement[];
  const pushTriggerButtons = Array.from(
    document.querySelectorAll('[data-action="push-trigger"]')
  ) as HTMLButtonElement[];
  const pushPanicButtons = Array.from(
    document.querySelectorAll('[data-action="push-panic"]')
  ) as HTMLButtonElement[];
  const run = async () => {
    const logs = document.getElementById('logs');
    if (logs) logs.innerHTML = '';
    startButtons.forEach(button => {
      button.disabled = true;
    });
    restartButtons.forEach(button => {
      button.disabled = true;
    });
    pushTriggerButtons.forEach(button => {
      button.disabled = true;
    });
    pushPanicButtons.forEach(button => {
      button.disabled = true;
    });
    try {
      await onRun();
      pushTriggerButtons.forEach(button => {
        button.disabled = false;
      });
      pushPanicButtons.forEach(button => {
        button.disabled = false;
      });
    } finally {
      startButtons.forEach(button => {
        button.disabled = false;
      });
      restartButtons.forEach(button => {
        button.disabled = false;
      });
    }
  };
  startButtons.forEach(button => {
    button.addEventListener('click', () => {
      void run();
    });
  });
  restartButtons.forEach(button => {
    button.addEventListener('click', () => {
      void run();
    });
  });
  pushTriggerButtons.forEach(button => {
    button.addEventListener('click', () => {
      void onPushTrigger?.();
    });
  });
  pushPanicButtons.forEach(button => {
    button.addEventListener('click', () => {
      void onPushPanic?.();
    });
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
