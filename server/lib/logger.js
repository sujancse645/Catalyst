/**
 * Structured JSON logger. Cloud Run forwards stdout to Google Cloud Logging,
 * which understands the `severity` field natively.
 */
export function createLogger({ silent = false } = {}) {
  const write = (severity, message, fields = {}) => {
    if (silent) return;
    const line = JSON.stringify({ severity, message, time: new Date().toISOString(), ...fields });
    if (severity === 'ERROR' || severity === 'WARNING') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    info: (m, f) => write('INFO', m, f),
    warn: (m, f) => write('WARNING', m, f),
    error: (m, f) => write('ERROR', m, f),
  };
}
