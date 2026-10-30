import ts from 'typescript';
import path from 'node:path';
const files = ['src/lib/atlasTypes.ts', 'src/lib/atlasImport.ts', 'src/lib/atlasExport.ts', 'src/components/AtlasTool.tsx', 'server/atlasApi.ts', 'server/atlasStore.ts'];
const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
const program = ts.createProgram(files, parsed.options);
const diagnostics = ts.getPreEmitDiagnostics(program);
const owned = new Set(files.map(p => path.resolve(p).toLowerCase()));
const ours = diagnostics.filter(d => !d.file || owned.has(path.resolve(d.file.fileName).toLowerCase()));
if (ours.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(ours, { getCanonicalFileName: p => p, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' }));
  process.exitCode = 1;
} else console.log(`PASS atlas-only TypeScript checks (${files.length} roots); ${diagnostics.length} dependency diagnostics outside owned files`);
