const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Row ids are `gen_random_uuid()` values. Postgres rejects anything else with
 * a query error, so a path parameter that is not a UUID is checked up front and
 * treated as "no such row" instead of reaching the database.
 */
export function isUuid(value: string): boolean {
	return UUID_PATTERN.test(value)
}
