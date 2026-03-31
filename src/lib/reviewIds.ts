export function makePolicyRowId(
  sectionIndex: number,
  tableIndex: number,
  rowIndex: number,
) {
  return `policy:${sectionIndex}:${tableIndex}:${rowIndex}`;
}

