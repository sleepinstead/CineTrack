// sql.js ships no types; the server touches it only through the small,
// locally typed surface in ./database.ts.
declare module 'sql.js' {
  const initSqlJs: (config?: { locateFile?: (file: string) => string }) => Promise<unknown>
  export default initSqlJs
}
