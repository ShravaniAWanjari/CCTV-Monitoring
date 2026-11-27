import type { ReportType } from '../data/types';

/** Report numbers: TYPE/SITE/MM/YY/NNNN, for example INC/MER/10/26/1407 (incident) or OBR/MER/10/26/1585 (observation). */
export const SITE_CODE = 'MER';
const PREFIX: Record<ReportType, string> = { Incident: 'INC', Observation: 'OBR', 'Near miss': 'NMR' };

export function reportRef(type: ReportType, at: number, n: number) {
  const d = new Date(at);
  return `${PREFIX[type]}/${SITE_CODE}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(-2)}/${String(n).padStart(4, '0')}`;
}
