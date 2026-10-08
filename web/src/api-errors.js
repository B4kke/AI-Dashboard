const COPY = {
  nb: {
    network: 'Klarte ikke å kontakte AI Dashboard. Kontroller at tjenesten kjører og prøv igjen.',
    request: 'Forespørselen ble avvist. Kontroller feltene og den viste tilstanden før du prøver igjen.',
    access: 'Handlingen er blokkert av sikkerhets- eller tilgangsreglene.',
    missing: 'Ressursen finnes ikke lenger. Oppdater visningen og prøv igjen.',
    conflict: 'Tilstanden har endret seg eller handlingen kolliderer med pågående arbeid. Oppdater status før du prøver igjen.',
    rateLimit: 'Tjenesten har nådd forespørselsgrensen. Reduser gjentatte oppdateringer og prøv igjen når grensen er frigitt.',
    server: 'AI Dashboard eller en integrasjon feilet. Sjekk Systemstatus og prøv igjen.',
    generic: 'Forespørselen mislyktes.',
  },
  en: {
    network: 'Could not reach AI Dashboard. Check that the service is running and try again.',
    request: 'The request was rejected. Check the fields and current state before trying again.',
    access: 'The action is blocked by the current security or access rules.',
    missing: 'The resource is no longer available. Refresh the view and try again.',
    conflict: 'The state changed or this action conflicts with work already in progress. Refresh the status before trying again.',
    rateLimit: 'The service has reached its request limit. Reduce repeated refreshes and try again after the limit clears.',
    server: 'AI Dashboard or an integration failed. Check System status and try again.',
    generic: 'The request failed.',
  },
};

function copyFor(locale) {
  return String(locale || 'nb').toLowerCase().startsWith('en') ? COPY.en : COPY.nb;
}

function boundedDetail(value) {
  const text = String(value || '').trim();
  if (text.length <= 600) return text;
  return `${text.slice(0, 599)}…`;
}

function summaryFor(status, locale) {
  const copy = copyFor(locale);
  if (status == null) return copy.network;
  if (status === 400 || status === 422) return copy.request;
  if (status === 401 || status === 403) return copy.access;
  if (status === 404) return copy.missing;
  if (status === 409) return copy.conflict;
  if (status === 429) return copy.rateLimit;
  if (status >= 500) return copy.server;
  return copy.generic;
}

export class ApiError extends Error {
  constructor({ status = null, detail = '', locale = 'nb', kind = 'http' } = {}) {
    const safeDetail = boundedDetail(detail);
    const summary = summaryFor(status, locale);
    const technicalDetail = status == null
      ? safeDetail
      : `HTTP ${status}${safeDetail ? ` · ${safeDetail}` : ''}`;
    super(summary);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
    this.detail = safeDetail;
    this.technicalDetail = technicalDetail;
  }
}

export function httpApiError(status, detail, locale = 'nb') {
  return new ApiError({ status, detail, locale, kind: 'http' });
}

export function networkApiError(error, locale = 'nb') {
  const detail = error instanceof Error ? error.message : String(error || '');
  return new ApiError({ status: null, detail, locale, kind: 'network' });
}
