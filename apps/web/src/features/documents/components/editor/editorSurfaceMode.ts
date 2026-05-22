export type EditorSurfaceMode = 'prose' | 'table' | 'code' | 'raw_text';

type ResolveEditorSurfaceModeOptions = {
  markdown: string;
  sourceFormat?: string;
};

const TABLE_SOURCE_FORMATS = new Set(['csv', 'tsv', 'xls', 'xlsx', 'xlsb', 'ods']);
const PLAIN_TEXT_SOURCE_FORMATS = new Set([
  'txt',
  'text',
  'log',
]);
const MARKDOWN_SOURCE_FORMATS = new Set(['md', 'markdown', 'mdown', 'mkd']);
const CODE_SOURCE_FORMATS = new Set([
  'rs',
  'ts',
  'tsx',
  'js',
  'jsx',
  'json',
  'py',
  'go',
  'java',
  'c',
  'cc',
  'cpp',
  'cxx',
  'h',
  'hpp',
  'cs',
  'php',
  'rb',
  'sh',
  'bash',
  'zsh',
  'sql',
  'yaml',
  'yml',
  'toml',
]);
const RASTER_IMAGE_SOURCE_FORMATS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'webp',
  'svg',
  'tif',
  'tiff',
  'heic',
  'heif',
]);
const NON_EDITABLE_SOURCE_FORMATS = new Set([
  'pdf',
  ...RASTER_IMAGE_SOURCE_FORMATS,
]);
const MIME_SOURCE_FORMATS = new Map<string, string>([
  ['application/pdf', 'pdf'],
  ['application/json', 'json'],
  ['application/x-ndjson', 'json'],
  ['application/x-yaml', 'yaml'],
  ['application/yaml', 'yaml'],
  ['application/xml', 'xml'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.oasis.opendocument.spreadsheet', 'ods'],
  ['application/msword', 'doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['text/markdown', 'md'],
  ['text/plain', 'txt'],
  ['text/csv', 'csv'],
  ['text/tab-separated-values', 'tsv'],
  ['text/x-rust', 'rs'],
  ['text/x-python', 'py'],
  ['text/javascript', 'js'],
  ['text/typescript', 'ts'],
  ['image/jpeg', 'jpg'],
]);

function normalizeSourceFormat(sourceFormat?: string): string | undefined {
  const raw = sourceFormat?.trim().toLowerCase().replace(/^\./, '');
  if (!raw) {
    return undefined;
  }

  const mapped = MIME_SOURCE_FORMATS.get(raw);
  if (mapped) {
    return mapped;
  }

  const mimeMatch = raw.match(/^([a-z0-9.+-]+)\/([a-z0-9.+-]+)$/);
  if (mimeMatch?.[1] === 'image') {
    return mimeMatch[2] === 'jpeg' ? 'jpg' : mimeMatch[2];
  }

  return raw;
}

export function isTableLikeSourceFormat(sourceFormat?: string): boolean {
  const normalized = normalizeSourceFormat(sourceFormat);
  return normalized ? TABLE_SOURCE_FORMATS.has(normalized) : false;
}

export function isCodeLikeSourceFormat(sourceFormat?: string): boolean {
  const normalized = normalizeSourceFormat(sourceFormat);
  return normalized ? CODE_SOURCE_FORMATS.has(normalized) : false;
}

export function isPlainTextSourceFormat(sourceFormat?: string): boolean {
  const normalized = normalizeSourceFormat(sourceFormat);
  return normalized ? PLAIN_TEXT_SOURCE_FORMATS.has(normalized) : false;
}

export function isMarkdownSourceFormat(sourceFormat?: string): boolean {
  const normalized = normalizeSourceFormat(sourceFormat);
  return normalized ? MARKDOWN_SOURCE_FORMATS.has(normalized) : false;
}

export function isRasterImageSourceFormat(sourceFormat?: string): boolean {
  const normalized = normalizeSourceFormat(sourceFormat);
  return normalized ? RASTER_IMAGE_SOURCE_FORMATS.has(normalized) : false;
}

export function isEditorEditableSourceFormat(sourceFormat?: string): boolean {
  const normalized = normalizeSourceFormat(sourceFormat);
  return normalized ? !NON_EDITABLE_SOURCE_FORMATS.has(normalized) : true;
}

export function codeLanguageForSourceFormat(sourceFormat?: string): string | undefined {
  const normalized = normalizeSourceFormat(sourceFormat);
  if (!normalized) {
    return undefined;
  }

  switch (normalized) {
    case 'rs':
      return 'rust';
    case 'py':
      return 'python';
    case 'rb':
      return 'ruby';
    case 'yml':
      return 'yaml';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'bash';
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
    case 'json':
    case 'go':
    case 'java':
    case 'c':
    case 'cc':
    case 'cpp':
    case 'cxx':
    case 'h':
    case 'hpp':
    case 'cs':
    case 'php':
    case 'sql':
    case 'toml':
      return normalized;
    default:
      return undefined;
  }
}

export function resolveEditorSurfaceMode({
  markdown,
  sourceFormat,
}: ResolveEditorSurfaceModeOptions): EditorSurfaceMode {
  if (isTableLikeSourceFormat(sourceFormat)) {
    return 'table';
  }

  if (isCodeLikeSourceFormat(sourceFormat)) {
    return 'code';
  }

  const tableSignal = countTableSignals(markdown);
  const codeSignal = countCodeSignals(markdown);

  if (tableSignal > 0 && tableSignal >= codeSignal) {
    return 'table';
  }

  if (codeSignal > 0) {
    return 'code';
  }

  return 'prose';
}

function countTableSignals(markdown: string): number {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const separatorMatches = normalized.match(/^\|\s*:?-{3,}.*\|$/gm) ?? [];
  const tableRowMatches = normalized.match(/^\|.*\|$/gm) ?? [];

  if (separatorMatches.length === 0 || tableRowMatches.length < 2) {
    return 0;
  }

  return separatorMatches.length + tableRowMatches.length;
}

function countCodeSignals(markdown: string): number {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const fenceMatches = normalized.match(/```/g)?.length ?? 0;
  if (fenceMatches >= 2) {
    return fenceMatches;
  }

  const lines = normalized.split('\n').map((line) => line.trimEnd());
  let score = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (/^(use\s+|import\s+|export\s+|from\s+|fn\s+|pub\s+|class\s+|interface\s+|type\s+|const\s+|let\s+|SELECT\s+|INSERT\s+|UPDATE\s+|DELETE\s+)/i.test(trimmed)) {
      score += 2;
      continue;
    }
    if (/^[{}()[\];,]+$/.test(trimmed) || /[{};]$/.test(trimmed)) {
      score += 1;
      continue;
    }
    if (/^\/[/*!]/.test(trimmed) || /^#\[/.test(trimmed)) {
      score += 1;
    }
  }

  return score >= 3 ? score : 0;
}
