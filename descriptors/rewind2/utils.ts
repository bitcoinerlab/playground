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
