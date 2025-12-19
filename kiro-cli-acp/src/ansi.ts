const ANSI_PATTERN =
  /[\u001B\u009B][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

