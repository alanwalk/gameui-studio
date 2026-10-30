/** Keep the usual Windows Edge setup, while allowing an explicitly installed CI browser. */
export function browserLaunchOptions() {
  const executablePath = process.env.GAMEUI_BROWSER_EXECUTABLE;
  if (!executablePath) return { channel: 'msedge', headless: true };
  return {
    executablePath,
    headless: true,
    // Also supports chrome-headless-shell in restricted Linux test containers.
    args: process.platform === 'linux' ? [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--no-zygote', '--single-process', '--in-process-gpu',
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    ] : [],
  };
}
