/** Shared prop types for the chart components (build-time only). */

export interface ChartSourceLink {
  title: string;
  url?: string | undefined;
  publisher?: string | undefined;
}

export type LegendKind = 'bar' | 'line' | 'dash' | 'dot' | 'estimate' | 'range';

export interface LegendItem {
  label: string;
  /** CSS colour, e.g. var(--chart-1) */
  color?: string | undefined;
  kind?: LegendKind | undefined;
  /** optional value shown in bold after the label (e.g. the latest share) */
  value?: string | undefined;
}

export interface TableColumn {
  key: string;
  label: string;
  /** right-aligned, tabular figures */
  numeric?: boolean | undefined;
}

export type TableCell = string | number | null | undefined;

export interface TableSpec {
  columns: TableColumn[];
  rows: Array<Record<string, TableCell>>;
  /** accessible caption; defaults to the chart title + 資料表 */
  caption?: string | undefined;
  /** column key rendered as <th scope="row"> (default: first column) */
  rowHeaderKey?: string | undefined;
}

/** Source references accepted by the simple MDX charts: a URL, a key, a Source object or a list. */
export interface SourceLike {
  key?: string | undefined;
  title: string;
  publisher?: string | undefined;
  url?: string | undefined;
}
