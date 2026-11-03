import type {
  AddedLinks,
  AggregateInput,
  AggregateResult,
  AssertionView,
  BulkDeleteImpact,
  ContextInput,
  ContextPack,
  DecisionResult,
  DeleteImpact,
  ForgetResult,
  InteractionQueryInput,
  InteractionQueryResult,
  LogInteractionResult,
  MergeInput,
  MergeResult,
  MergeSuggestionDecision,
  Page,
  PresentedFact,
  PresentedInteraction,
  PresentedRecord,
  QueryInput,
  RecordPage,
  RetractInteractionResult,
  ReviewCollection,
  ReviewQueue,
  SchemaChange,
  SchemaChangeResult,
  SchemaDescription,
  SchemaOperation,
  SearchInput,
  SearchResult,
  Session,
  TemplateView,
  WriteResponse,
} from '@retainer/shared';
export type RetainerClientOptions = {
  baseUrl: string;
  apiKey?: string;
  credentials?: 'omit' | 'same-origin' | 'include';
  fetch?: typeof fetch;
  onUnauthorized?: () => void;
};
export type HealthResponse = {
  status: 'ok' | 'error';
  version: string;
  database: 'ok' | 'unreachable';
};
export class RetainerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RetainerApiError';
  }
}
export type PageOptions = { limit?: number; cursor?: string; signal?: AbortSignal };
export type PatchInput = {
  values: Record<string, unknown>;
  expectedUpdatedAt?: string;
  source?: string;
};
export type UpsertInput = PatchInput & {
  id?: string;
  match?: Record<string, unknown>;
  ifMissing?: 'fail' | 'create';
};
export type LogInteractionInput = {
  kind: 'meeting' | 'call' | 'email' | 'message' | 'note';
  channel: string;
  occurredAt: string;
  externalId?: string;
  title?: string;
  summary?: string;
  /** Who took part. */
  participants?: Participant[];
  /** IDs of the records it concerns, e.g. the company and project of a meeting. */
  about?: string[];
};
type Participant = { handle?: string; recordId?: string; role?: string };
const isFailedChange = (body: unknown) =>
  typeof body === 'object' && body !== null && (body as { status?: unknown }).status === 'failed';
export class RetainerClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: RetainerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  protected headers(): Record<string, string> {
    return this.options.apiKey
      ? { authorization: `Bearer ${this.options.apiKey}` }
      : { 'X-Retainer-Client': 'web' };
  }
  /** `isResult` lets an error status whose body is a result come back as one. */
  private async request<T>(
    path: string,
    init: RequestInit = {},
    isResult?: (body: unknown) => boolean,
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      credentials: this.options.credentials ?? 'same-origin',
      headers: {
        ...this.headers(),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    };
    if (!response.ok && !isResult?.(body)) {
      if (response.status === 401 && path !== '/auth/session') this.options.onUnauthorized?.();
      throw new RetainerApiError(
        response.status,
        body.error?.code ?? 'request_failed',
        body.error?.message ?? response.statusText,
        body.error?.details,
      );
    }
    return body as T;
  }
  private query(path: string, params: Record<string, unknown>, signal?: AbortSignal) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    return { path: `${path}${qs.size ? `?${qs}` : ''}`, signal };
  }
  private get<T>(path: string, params: Record<string, unknown> = {}, signal?: AbortSignal) {
    const q = this.query(path, params, signal);
    return this.request<T>(q.path, { signal });
  }
  private post<T>(path: string, body?: unknown, signal?: AbortSignal, idempotencyKey?: string) {
    return this.request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    });
  }
  /** Health reports database outages in its response body, including HTTP 503. */
  async health(): Promise<HealthResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/health`);
    return (await response.json()) as HealthResponse;
  }
  signIn(key: string) {
    return this.post<Session>('/auth/session', { key });
  }
  signOut() {
    return this.request<{ signedOut: true }>('/auth/session', { method: 'DELETE' });
  }
  me(signal?: AbortSignal) {
    return this.get<Session>('/v1/me', {}, signal);
  }
  schema(signal?: AbortSignal) {
    return this.get<SchemaDescription>('/v1/schema', {}, signal);
  }
  templates(signal?: AbortSignal) {
    return this.get<{ templates: TemplateView[] }>('/v1/templates', {}, signal);
  }
  applyTemplate(name: string) {
    return this.post<SchemaChangeResult>(`/v1/templates/${encodeURIComponent(name)}/apply`);
  }
  queryRecords(object: string, input: QueryInput = {}, signal?: AbortSignal) {
    return this.post<RecordPage>(`/v1/objects/${encodeURIComponent(object)}/query`, input, signal);
  }
  record(
    id: string,
    include: string[] = ['provenance', 'relationReferences'],
    signal?: AbortSignal,
  ) {
    return this.get<PresentedRecord>(
      `/v1/records/${encodeURIComponent(id)}`,
      { include: include.join(',') },
      signal,
    );
  }
  createRecord(
    object: string,
    input: { values: Record<string, unknown>; source?: string },
    idempotencyKey?: string,
  ) {
    return this.post<WriteResponse>(
      `/v1/objects/${encodeURIComponent(object)}/records`,
      input,
      undefined,
      idempotencyKey,
    );
  }
  upsertRecord(object: string, input: UpsertInput) {
    return this.post<WriteResponse>(`/v1/objects/${encodeURIComponent(object)}/upsert`, input);
  }
  patchRecord(id: string, input: PatchInput) {
    return this.request<WriteResponse>(`/v1/records/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }
  /** What deleting the record would delete with it; changes nothing. */
  deleteImpact(id: string, signal?: AbortSignal) {
    return this.get<DeleteImpact>(
      `/v1/records/${encodeURIComponent(id)}/delete-impact`,
      {},
      signal,
    );
  }
  /** What deleting several records together would delete with them. */
  bulkDeleteImpact(ids: string[], signal?: AbortSignal) {
    return this.post<BulkDeleteImpact>('/v1/records/delete-impact', { ids }, signal);
  }
  /** The total and requested aggregates over the records a filter matches. */
  aggregate(object: string, input: AggregateInput = {}, signal?: AbortSignal) {
    return this.post<AggregateResult>(
      `/v1/objects/${encodeURIComponent(object)}/aggregate`,
      input,
      signal,
    );
  }
  deleteRecord(id: string) {
    return this.request<{ id: string; deleted: true; deletedRecordIds: string[] }>(
      `/v1/records/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
  }
  /** Merges `input.recordId` into `id`, which survives. Retrying with the same key is safe. */
  mergeRecords(id: string, input: MergeInput, idempotencyKey?: string) {
    return this.post<MergeResult>(
      `/v1/records/${encodeURIComponent(id)}/merge`,
      input,
      undefined,
      idempotencyKey,
    );
  }
  /** Erases a person and what was logged about them (needs the `admin` scope). Not reversible. */
  forget(id: string) {
    return this.post<ForgetResult>(`/v1/records/${encodeURIComponent(id)}/forget`);
  }
  search(input: SearchInput, signal?: AbortSignal) {
    return this.post<SearchResult>('/v1/search', input, signal);
  }
  context(id: string, input: ContextInput = {}, signal?: AbortSignal) {
    return this.get<ContextPack>(`/v1/records/${encodeURIComponent(id)}/context`, input, signal);
  }
  dismissMergeSuggestion(id: string) {
    return this.post<MergeSuggestionDecision>(
      `/v1/review/merges/${encodeURIComponent(id)}/dismiss`,
    );
  }
  review(
    options: Omit<PageOptions, 'cursor'> &
      Partial<Record<`${ReviewCollection}Cursor`, string>> = {},
  ) {
    const { signal, ...params } = options;
    return this.get<ReviewQueue>('/v1/review', params, signal);
  }
  assertion(id: string, signal?: AbortSignal) {
    return this.get<AssertionView>(`/v1/assertions/${encodeURIComponent(id)}`, {}, signal);
  }
  decideAssertion(id: string, decision: 'accept' | 'reject') {
    return this.post<DecisionResult>(`/v1/assertions/${encodeURIComponent(id)}/${decision}`);
  }
  assertions(id: string, options: PageOptions & { field?: string } = {}) {
    const { signal, ...params } = options;
    return this.get<Page<AssertionView>>(
      `/v1/records/${encodeURIComponent(id)}/assertions`,
      params,
      signal,
    );
  }
  recordInteractions(id: string, options: PageOptions = {}) {
    const { signal, ...params } = options;
    return this.get<Page<PresentedInteraction>>(
      `/v1/records/${encodeURIComponent(id)}/interactions`,
      params,
      signal,
    );
  }
  facts(id: string, options: PageOptions = {}) {
    const { signal, ...params } = options;
    return this.get<{ record: string; facts: PresentedFact[]; nextCursor: string | null }>(
      `/v1/records/${encodeURIComponent(id)}/facts`,
      params,
      signal,
    );
  }
  remember(
    id: string,
    input: { text: string; source?: string; quote?: string },
    idempotencyKey?: string,
  ) {
    return this.post<{ fact: PresentedFact; noteInteraction: string | null }>(
      `/v1/records/${encodeURIComponent(id)}/facts`,
      input,
      undefined,
      idempotencyKey,
    );
  }
  retractFact(id: string) {
    return this.request<{ id: string; deleted: true }>(`/v1/facts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
  interaction(id: string, signal?: AbortSignal) {
    return this.get<PresentedInteraction>(`/v1/interactions/${encodeURIComponent(id)}`, {}, signal);
  }
  logInteraction(input: LogInteractionInput) {
    return this.post<LogInteractionResult>('/v1/interactions', input);
  }
  /** Lists and counts interactions by kind, channel, time and linked record. */
  queryInteractions(input: InteractionQueryInput = {}, signal?: AbortSignal) {
    return this.post<InteractionQueryResult>('/v1/interactions/query', input, signal);
  }
  /** Adds participants and `about` records to a logged interaction; idempotent. */
  addInteractionLinks(id: string, input: { participants?: Participant[]; about?: string[] }) {
    return this.post<PresentedInteraction & { added: AddedLinks }>(
      `/v1/interactions/${encodeURIComponent(id)}/participants`,
      input,
    );
  }
  /** Removes one participant (a person's key only). */
  removeParticipant(id: string, participantId: string) {
    return this.request<PresentedInteraction>(
      `/v1/interactions/${encodeURIComponent(id)}/participants/${encodeURIComponent(participantId)}`,
      { method: 'DELETE' },
    );
  }
  /** Removes a record from an interaction's `about` list (a person's key only). */
  removeAbout(id: string, recordId: string) {
    return this.request<PresentedInteraction>(
      `/v1/interactions/${encodeURIComponent(id)}/about/${encodeURIComponent(recordId)}`,
      { method: 'DELETE' },
    );
  }
  retractInteraction(id: string) {
    return this.request<RetractInteractionResult>(`/v1/interactions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }
  claims(
    id: string,
    options: Omit<PageOptions, 'cursor'> & { assertionsCursor?: string; factsCursor?: string } = {},
  ) {
    const { signal, ...params } = options;
    return this.get<{
      assertions: AssertionView[];
      facts: PresentedFact[];
      nextCursors: { assertions: string | null; facts: string | null };
    }>(`/v1/interactions/${encodeURIComponent(id)}/claims`, params, signal);
  }
  schemaChanges(options: PageOptions & { status?: string } = {}) {
    const { signal, ...params } = options;
    return this.get<{ changes: SchemaChange[]; total: number; nextCursor: string | null }>(
      '/v1/schema/changes',
      params,
      signal,
    );
  }
  schemaChange(id: string, signal?: AbortSignal) {
    return this.get<SchemaChange>(`/v1/schema/changes/${encodeURIComponent(id)}`, {}, signal);
  }
  /**
   * A change that existing records block comes back as 409 with the change
   * itself (`status: "failed"`, its `error` and the blocking `recordIds`),
   * so it is returned like any other outcome rather than thrown.
   */
  proposeSchemaChange(operations: SchemaOperation[], reason?: string) {
    return this.request<SchemaChangeResult>(
      '/v1/schema/changes',
      { method: 'POST', body: JSON.stringify({ operations, reason }) },
      isFailedChange,
    );
  }
  decideSchemaChange(id: string, decision: 'approve' | 'reject') {
    return this.request<SchemaChangeResult>(
      `/v1/schema/changes/${encodeURIComponent(id)}/${decision}`,
      { method: 'POST' },
      isFailedChange,
    );
  }
}
