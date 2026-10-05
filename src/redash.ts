import { z } from "zod";

export interface RedashConfig {
	REDASH_BASE_URL?: string;
	REDASH_API_KEY?: string;
}

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const rowLimit = z.number().int().min(1).max(1000);
const querySchema = z.object({
	id: positiveId,
	name: z.string(),
	query: z.string().optional(),
	description: z.string().nullable().optional(),
	data_source_id: positiveId.nullable().optional(),
	options: z.object({ parameters: z.array(z.unknown()).optional() }).optional(),
	tags: z.array(z.string()).optional(),
	latest_query_data_id: positiveId.nullable().optional(),
});
const resultSchema = z.object({
	query_result: z.object({
		id: positiveId,
		retrieved_at: z.string().optional(),
		runtime: z.number().optional(),
		data: z.object({ columns: z.array(z.unknown()), rows: z.array(z.unknown()) }),
	}),
});
const jobSchema = z.object({
	job: z.object({
		id: z.union([z.string(), positiveId]),
		status: z.number().int().min(1).max(5),
		query_result_id: positiveId.nullable().optional(),
	}),
});
const STATUS_NAMES = ["", "pending", "started", "success", "failure", "cancelled"];
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function parseResponse<T>(schema: z.ZodType<T>, body: unknown): T {
	const result = schema.safeParse(body);
	if (!result.success) throw new Error("Redash returned an unexpected response format.");
	return result.data;
}

function summarizeResult(body: unknown, maxRows: number, queryId?: number) {
	rowLimit.parse(maxRows);
	const { query_result: result } = parseResponse(resultSchema, body);
	return {
		...(queryId === undefined ? {} : { query_id: queryId }),
		query_result_id: result.id,
		retrieved_at: result.retrieved_at,
		runtime: result.runtime,
		columns: result.data.columns,
		rows: result.data.rows.slice(0, maxRows),
		total_rows: result.data.rows.length,
		returned_rows: Math.min(result.data.rows.length, maxRows),
		truncated: result.data.rows.length > maxRows,
	};
}

function summarizeJob(body: unknown) {
	const { job } = parseResponse(jobSchema, body);
	// Do not expose upstream error text: it can contain SQL, credentials or internal details.
	return { ...job, status_name: STATUS_NAMES[job.status] };
}

async function readJson(response: Response): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Redash returned an empty response.");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new Error("Redash result exceeds 5 MiB. Use a smaller query result.");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const buffer = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try { return JSON.parse(new TextDecoder().decode(buffer)); }
	catch { throw new Error("Redash returned invalid JSON."); }
}

/** Redash API transport. The base URL and credential are server-side settings only. */
export class RedashClient {
	private readonly config: RedashConfig;
	private readonly fetcher: typeof fetch;

	constructor(config: RedashConfig, fetcher: typeof fetch = fetch) {
		this.config = config;
		this.fetcher = fetcher;
	}

	private async request(path: string, body?: unknown, search?: Record<string, string>): Promise<unknown> {
		if (!this.config.REDASH_BASE_URL || !this.config.REDASH_API_KEY) {
			throw new Error("Set REDASH_BASE_URL and REDASH_API_KEY on the server.");
		}
		let base: URL;
		try { base = new URL(this.config.REDASH_BASE_URL); }
		catch { throw new Error("REDASH_BASE_URL must be a valid HTTP(S) URL."); }
		if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
			throw new Error("REDASH_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment.");
		}
		base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
		const url = new URL(`api/${path}`, base);
		for (const [key, value] of Object.entries(search ?? {})) url.searchParams.set(key, value);
		let response: Response;
		try {
			response = await this.fetcher(url, {
				method: body === undefined ? "GET" : "POST",
				headers: {
					Authorization: `Key ${this.config.REDASH_API_KEY}`,
					Accept: "application/json",
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				redirect: "error",
				signal: AbortSignal.timeout(15000),
			});
		} catch {
			throw new Error("Redash request failed or timed out. Check the server URL and connectivity.");
		}
		if (!response.ok) {
			const hints: Record<number, string> = {
				401: "Check REDASH_API_KEY.",
				403: "The API key does not have permission for this operation.",
				404: "Query, job or cached result not found. Check the ID.",
			};
			throw new Error(`Redash returned HTTP ${response.status}. ${hints[response.status] ?? "Check Redash availability."}`);
		}
		try { return await readJson(response); }
		catch (error) {
			if (error instanceof Error && /^Redash (result exceeds|returned)/.test(error.message)) throw error;
			throw new Error("Redash response could not be read or timed out.");
		}
	}

	async searchQueries(term: string, page = 1, pageSize = 25) {
		z.string().trim().min(1).max(200).parse(term);
		positiveId.parse(page);
		z.number().int().min(1).max(100).parse(pageSize);
		// /queries/search redirects; call the paginated search endpoint directly.
		const body = await this.request("queries", undefined, { q: term.trim(), page: String(page), page_size: String(pageSize) });
		const result = parseResponse(z.object({ count: z.number().int().nonnegative(), results: z.array(querySchema) }), body);
		return { count: result.count, page, page_size: pageSize, queries: result.results.map(({ query, options, ...summary }) => summary) };
	}

	async getQuery(queryId: number) {
		positiveId.parse(queryId);
		return parseResponse(querySchema, await this.request(`queries/${queryId}`));
	}

	async getQueryResult(queryId: number, maxRows = 100) {
		positiveId.parse(queryId);
		rowLimit.parse(maxRows);
		return summarizeResult(await this.request(`queries/${queryId}/results.json`), maxRows, queryId);
	}

	async runQuery(queryId: number, parameters: Record<string, unknown> = {}, maxAge = 0, maxRows = 100) {
		positiveId.parse(queryId);
		z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(maxAge);
		rowLimit.parse(maxRows);
		const body = await this.request(`queries/${queryId}/results`, { parameters, max_age: maxAge });
		if (resultSchema.safeParse(body).success) {
			return { kind: "result", ...summarizeResult(body, maxRows, queryId) };
		}
		return { kind: "job", query_id: queryId, ...summarizeJob(body) };
	}

	async getJob(jobId: string) {
		z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).parse(jobId);
		return summarizeJob(await this.request(`jobs/${encodeURIComponent(jobId)}`));
	}

	async getResult(resultId: number, maxRows = 100) {
		positiveId.parse(resultId);
		rowLimit.parse(maxRows);
		return summarizeResult(await this.request(`query_results/${resultId}.json`), maxRows);
	}
}

// Retain the original helper for existing callers.
export function getRedashQueryResult(config: RedashConfig, queryId: number, maxRows = 100, fetcher: typeof fetch = fetch) {
	return new RedashClient(config, fetcher).getQueryResult(queryId, maxRows);
}
