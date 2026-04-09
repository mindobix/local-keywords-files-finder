/**
 * crawler/parsers/ods.js
 *
 * SheetJS handles ODS (LibreOffice Calc) and partial .numbers (Apple Numbers)
 * using the same API as XLSX. We simply re-export the XLSX parser under a
 * different name so callers have a consistent module per extension.
 */

export { parseXLSX as parseODS } from './xlsx.js';
