import axios from 'axios';
import https from 'https';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ── Auth helpers ───────────────────────────────────────────────────────────────

function buildEnv(): { baseUrl: string; auth: string; client: string; language: string | undefined } {
  const baseUrl = process.env.BW_URL;
  const user = process.env.BW_USER;
  const pass = process.env.BW_PASSWORD;
  if (!baseUrl || !user || !pass) {
    throw new Error('BW_URL, BW_USER, and BW_PASSWORD must be set');
  }
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    auth: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
    client: process.env.BW_CLIENT ?? '001',
    language: process.env.BW_LANGUAGE,
  };
}

// ── Parameter types ────────────────────────────────────────────────────────────

export interface SelectionOption {
  low: string;
  high?: string;
  /** EQ=equal, BT=between, LT<, LE<=, GT>, GE>=, NE<> */
  option?: 'EQ' | 'BT' | 'LT' | 'LE' | 'GT' | 'GE' | 'NE';
  /** I=include (default), E=exclude */
  sign?: 'I' | 'E';
}

export interface VariableInput {
  name: string;
  values: SelectionOption[];
}

export interface DimensionFilter {
  dimension: string;
  values: SelectionOption[];
}

export interface HierarchyNode {
  dimension: string;
  node: string;
  action: 'expand' | 'collapse';
}

export interface MemberSelection {
  dimension: string;
  members: string[];
}

export interface QueryDataParams {
  provider_name: string;
  provider_type?: 'QUERY' | 'ADSO' | 'HCPR';
  variables?: VariableInput[];
  filters?: DimensionFilter[];
  rows?: string[];
  columns?: string[];
  free?: string[];
  hierarchy_nodes?: HierarchyNode[];
  selected_members?: MemberSelection[];
  max_rows?: number;
  start_row?: number;
}

// ── InA request builder ────────────────────────────────────────────────────────

const MEASURES = '[Measures]';

function buildInaRequest(params: QueryDataParams): Record<string, unknown> {
  const inaType = params.provider_type === 'QUERY' || !params.provider_type
    ? 'Query'
    : 'MultiDimensionalModel';

  // Build member-selection lookup: dimension → explicit member list
  const memberMap = new Map<string, string[]>();
  for (const ms of params.selected_members ?? []) {
    memberMap.set(ms.dimension, ms.members);
  }

  const makeDimEntry = (name: string, axis: number): Record<string, unknown> => {
    const entry: Record<string, unknown> = {
      Name: name,
      Axis: axis,
      KeyFigureDimension: name === MEASURES,
    };
    const selected = memberMap.get(name);
    if (selected && selected.length > 0) {
      entry['Members'] = selected.map((m) => ({ Name: m }));
    }
    return entry;
  };

  const dimensions: Record<string, unknown>[] = [];
  const hasExplicitLayout = !!(params.rows?.length || params.columns?.length || params.free?.length);

  if (hasExplicitLayout) {
    for (const d of params.rows ?? []) dimensions.push(makeDimEntry(d, 1));
    // Columns: if not specified but rows are, default measures to columns
    const cols = params.columns ?? [MEASURES];
    for (const d of cols) dimensions.push(makeDimEntry(d, 0));
    for (const d of params.free ?? []) dimensions.push(makeDimEntry(d, 2));
  }
  // If no layout specified, omit Dimensions entirely → server uses query default layout

  const variables = (params.variables ?? []).map((v) => ({
    Name: v.name,
    Values: v.values.map((s) => ({
      Low: s.low,
      High: s.high ?? '',
      Option: s.option ?? 'EQ',
      Sign: s.sign ?? 'I',
    })),
  }));

  const filters = (params.filters ?? []).map((f) => ({
    SetOperand: {
      Code: f.dimension,
      Values: f.values.map((v) => ({
        Low: v.low,
        High: v.high ?? '',
        Option: v.option ?? 'EQ',
        Sign: v.sign ?? 'I',
      })),
    },
  }));

  const definition: Record<string, unknown> = {
    Variables: variables,
    Filters: filters,
    Options: { ReturnDataForecast: 0, DataRefreshInterval: 0 },
  };
  if (dimensions.length > 0) definition['Dimensions'] = dimensions;

  if (params.hierarchy_nodes && params.hierarchy_nodes.length > 0) {
    definition['HierarchyDrilldown'] = params.hierarchy_nodes.map((h) => ({
      Dimension: h.dimension,
      Node: h.node,
      DrillDown: h.action === 'expand',
    }));
  }

  return {
    Analytics: {
      DataSource: {
        ObjectName: params.provider_name,
        Type: inaType,
        SchemaName: '',
        PackageName: '',
      },
      Capabilities: {
        VariableSubmit: true,
        ResultSetTransport: 2,
      },
      Definition: definition,
      Paging: {
        ClientHandlesResultSet: false,
        MaxRows: params.max_rows ?? 1000,
        StartRow: params.start_row ?? 0,
      },
    },
  };
}

// ── InA response types ─────────────────────────────────────────────────────────

interface InaMember {
  Name?: string;
  Description?: string;
  Level?: number;
  DrillState?: string; // L=leaf, E=expanded, C=collapsed
}

interface InaAxisDimension {
  Name?: string;
  Description?: string;
  Members?: InaMember[];
}

interface InaAxis {
  Dimensions?: InaAxisDimension[];
}

interface InaResultSet {
  TotalNumberOfRecords?: number;
  Axes?: InaAxis[];
  Cells?: {
    Values?: (number | string | null)[];
    FormattedValues?: (string | null)[];
  };
}

function parseInaResponse(data: unknown): {
  colAxis: InaAxis | null;
  rowAxis: InaAxis | null;
  cells: (string | null)[];
  total: number;
} {
  const root = data as Record<string, unknown>;
  // Handle both { Analytics: { ResultSet } } and { ResultSet } wrappers
  const analytics = (root['Analytics'] ?? root) as Record<string, unknown>;

  const msgs = analytics['Messages'] as unknown[] | undefined;
  const errors = (msgs ?? []).filter(
    (m) => (m as Record<string, unknown>)?.['Severity'] === 'Error' ||
            (m as Record<string, unknown>)?.['Type'] === 'Error'
  );
  if (errors.length > 0) {
    throw new Error(`InA returned errors:\n${JSON.stringify(errors, null, 2)}`);
  }

  const rs = analytics['ResultSet'] as InaResultSet | undefined;
  if (!rs) {
    throw new Error(
      `InA returned no ResultSet. Response:\n${JSON.stringify(data, null, 2).slice(0, 2000)}`
    );
  }

  const axes = rs.Axes ?? [];
  const colAxis = axes[0] ?? null;
  const rowAxis = axes[1] ?? null;
  const total = rs.TotalNumberOfRecords ?? 0;

  // Prefer formatted values (localised) over raw numbers
  const raw = rs.Cells?.FormattedValues ?? rs.Cells?.Values ?? [];
  const cells: (string | null)[] = raw.map((v) =>
    v === null || v === undefined ? null : String(v)
  );

  return { colAxis, rowAxis, cells, total };
}

// ── Table renderer ─────────────────────────────────────────────────────────────

function renderTable(
  colAxis: InaAxis | null,
  rowAxis: InaAxis | null,
  cells: (string | null)[],
  total: number,
  startRow: number,
): string {
  const colDims = colAxis?.Dimensions ?? [];
  const rowDims = rowAxis?.Dimensions ?? [];

  const numCols = colDims[0]?.Members?.length ?? 0;
  const numRows = rowDims[0]?.Members?.length ?? 0;

  if (numRows === 0 && numCols === 0) return 'No data returned.';

  // Column headers: join across all col-axis dimensions at each position
  const colHeaders: string[] = [];
  for (let c = 0; c < numCols; c++) {
    const parts = colDims.map((d) => {
      const m = d.Members?.[c];
      return m?.Description ?? m?.Name ?? '';
    });
    colHeaders.push(parts.join(' / '));
  }

  // Row-axis dimension header labels
  const rowDimHeaders = rowDims.map((d) => d.Description ?? d.Name ?? '');

  // Helper: display text for a row-axis member (with hierarchy indent + drill symbol)
  const memberText = (dim: InaAxisDimension, r: number): string => {
    const m = dim.Members?.[r];
    if (!m) return '';
    const indent = '  '.repeat(m.Level ?? 0);
    const sym = m.DrillState === 'E' ? 'v ' : m.DrillState === 'C' ? '> ' : '  ';
    return indent + sym + (m.Description ?? m.Name ?? '');
  };

  const cellText = (r: number, c: number): string => {
    const v = cells[r * (numCols || 1) + c];
    return v ?? '';
  };

  // Compute column widths
  const allHeaders = [...rowDimHeaders, ...colHeaders];
  const widths = allHeaders.map((h) => h.length);

  for (let r = 0; r < numRows; r++) {
    for (let d = 0; d < rowDims.length; d++) {
      widths[d] = Math.max(widths[d], memberText(rowDims[d], r).length);
    }
    for (let c = 0; c < colHeaders.length; c++) {
      widths[rowDims.length + c] = Math.max(widths[rowDims.length + c], cellText(r, c).length);
    }
  }

  const numRowDims = rowDims.length;
  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const lines: string[] = [sep];

  // Header row
  lines.push('| ' + allHeaders.map((h, i) => h.padEnd(widths[i])).join(' | ') + ' |');
  lines.push(sep);

  // Data rows
  for (let r = 0; r < numRows; r++) {
    const parts: string[] = [];
    for (let d = 0; d < numRowDims; d++) {
      parts.push(memberText(rowDims[d], r).padEnd(widths[d]));
    }
    for (let c = 0; c < Math.max(colHeaders.length, 1); c++) {
      const text = cellText(r, c);
      // Right-align data cells, left-align row-dim cells
      parts.push(text.padStart(widths[numRowDims + c]));
    }
    lines.push('| ' + parts.join(' | ') + ' |');
  }

  lines.push(sep);

  const shown = startRow + numRows;
  if (total > 0 && total > shown) {
    lines.push(`\n(Rows ${startRow + 1}–${shown} of ${total}. Use start_row / max_rows to paginate.)`);
  } else {
    lines.push(`\n(${numRows} row${numRows !== 1 ? 's' : ''})`);
  }

  return lines.join('\n');
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function bwQueryData(params: QueryDataParams): Promise<string> {
  const { baseUrl, auth, client, language } = buildEnv();
  const request = buildInaRequest(params);

  const response = await axios.post(
    `${baseUrl}/sap/bw/ina/GetResponse`,
    JSON.stringify(request),
    {
      httpsAgent,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: auth,
        'sap-client': client,
        ...(language ? { 'sap-language': language } : {}),
      },
      responseType: 'text',
      validateStatus: () => true,
    }
  );

  if (response.status >= 400) {
    throw new Error(
      `InA GetResponse → HTTP ${response.status}\n${(response.data as string).slice(0, 1000)}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.data as string);
  } catch {
    throw new Error(`InA response is not valid JSON:\n${(response.data as string).slice(0, 500)}`);
  }

  const { colAxis, rowAxis, cells, total } = parseInaResponse(parsed);
  return renderTable(colAxis, rowAxis, cells, total, params.start_row ?? 0);
}
