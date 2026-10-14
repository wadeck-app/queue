import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';
import { DEFAULT_HISTORY_LIMIT } from '@wadeck-app/queue-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type YamlDoc = Record<string, unknown>;
type Section = Record<string, unknown>;

describe('history-page.yaml pagination structure', () => {
	const yamlPath = join(__dirname, '../dsl-frontend/history-page.yaml');
	const yamlContent = readFileSync(yamlPath, 'utf-8');
	const doc = yaml.load(yamlContent) as YamlDoc;

	it('$sources.history.url resolves to GET endpoint', () => {
		const historySource = (doc.$sources as Record<string, unknown>)
			?.history as Record<string, unknown>;
		expect(historySource?.url).toBe('GET /api/modules/queue/history');
	});

	it('$sources.history.params deep-equals page/limit from urlParam', () => {
		const historySource = (doc.$sources as Record<string, unknown>)
			?.history as Record<string, unknown>;
		const params = historySource?.params as Record<string, unknown>;
		expect(params).toEqual({
			page: '$urlParam.page',
			limit: '$urlParam.size',
		});
	});

	it('root $type is PageContent', () => {
		expect(doc.$type).toBe('PageContent');
	});

	it('DataTable section has rows bound to $sources.history.entries', () => {
		const sections = doc.sections as Section[];
		const dataTableSection = sections.find((s) => s.$type === 'DataTable');
		expect(dataTableSection).toBeDefined();
		expect(dataTableSection?.rows).toBe('$sources.history.entries');
	});

	it('DataTable has 6 columns in order: ts, event, eventId, project, matchedCount, totalCount', () => {
		const sections = doc.sections as Section[];
		const dataTableSection = sections.find(
			(s) => s.$type === 'DataTable'
		) as Section;
		const columns = dataTableSection?.columns as Array<Record<string, unknown>>;

		expect(columns).toHaveLength(6);
		expect(columns[0].key).toBe('ts');
		expect(columns[1].key).toBe('event');
		expect(columns[2].key).toBe('eventId');
		expect(columns[3].key).toBe('project');
		expect(columns[4].key).toBe('matchedCount');
		expect(columns[5].key).toBe('totalCount');
	});

	it('DataTable ts column has format: datetime', () => {
		const sections = doc.sections as Section[];
		const dataTableSection = sections.find(
			(s) => s.$type === 'DataTable'
		) as Section;
		const columns = dataTableSection?.columns as Array<Record<string, unknown>>;
		expect(columns[0].format).toBe('datetime');
	});

	it('DataTable eventId column has mono: true', () => {
		const sections = doc.sections as Section[];
		const dataTableSection = sections.find(
			(s) => s.$type === 'DataTable'
		) as Section;
		const columns = dataTableSection?.columns as Array<Record<string, unknown>>;
		expect(columns[2].mono).toBe(true);
	});

	it('HorizontalStack has items key and no children key', () => {
		const sections = doc.sections as Section[];
		const stackSection = sections.find(
			(s) => s.$type === 'HorizontalStack'
		) as Section;
		expect(stackSection).toBeDefined();
		expect(stackSection?.items).toBeDefined();
		expect(stackSection?.children).toBeUndefined();
	});

	it('HorizontalStack uses Tailwind class for gap, align, justify', () => {
		const sections = doc.sections as Section[];
		const stackSection = sections.find(
			(s) => s.$type === 'HorizontalStack'
		) as Section;
		const gapRegex = /^(gap)-/;
		const alignRegex = /^(items)-/;
		const justifyRegex = /^(justify)-/;

		expect(String(stackSection?.gap)).toMatch(gapRegex);
		expect(String(stackSection?.align)).toMatch(alignRegex);
		expect(String(stackSection?.justify)).toMatch(justifyRegex);
	});

	it('HorizontalStack items contains Pagination with urlParam: page, total: $sources.history.total, size: $sources.history.limit', () => {
		const sections = doc.sections as Section[];
		const stackSection = sections.find(
			(s) => s.$type === 'HorizontalStack'
		) as Section;
		const items = stackSection?.items as Section[];
		const paginationNode = items.find((item) => item.$type === 'Pagination');

		expect(paginationNode).toBeDefined();
		expect(paginationNode?.urlParam).toBe('page');
		expect(paginationNode?.total).toBe('$sources.history.total');
		expect(paginationNode?.size).toBe('$sources.history.limit');
	});

	it('HorizontalStack items contains PageSizeSelect with urlParam: size, options: [20, 50, 100]', () => {
		const sections = doc.sections as Section[];
		const stackSection = sections.find(
			(s) => s.$type === 'HorizontalStack'
		) as Section;
		const items = stackSection?.items as Section[];
		const pageSizeNode = items.find((item) => item.$type === 'PageSizeSelect');

		expect(pageSizeNode).toBeDefined();
		expect(pageSizeNode?.urlParam).toBe('size');
		expect(pageSizeNode?.options).toEqual([20, 50, 100]);
	});

	it('PageSizeSelect options include DEFAULT_HISTORY_LIMIT (20)', () => {
		const sections = doc.sections as Section[];
		const stackSection = sections.find(
			(s) => s.$type === 'HorizontalStack'
		) as Section;
		const items = stackSection?.items as Section[];
		const pageSizeNode = items.find(
			(item) => item.$type === 'PageSizeSelect'
		) as Section;
		const options = pageSizeNode?.options as number[];

		expect(DEFAULT_HISTORY_LIMIT).toBe(20);
		expect(options).toContain(DEFAULT_HISTORY_LIMIT);
	});

	it('HorizontalStack items has Pagination before PageSizeSelect', () => {
		const sections = doc.sections as Section[];
		const stackSection = sections.find(
			(s) => s.$type === 'HorizontalStack'
		) as Section;
		const items = stackSection?.items as Section[];

		const paginationIdx = items.findIndex((item) => item.$type === 'Pagination');
		const pageSizeIdx = items.findIndex(
			(item) => item.$type === 'PageSizeSelect'
		);

		expect(paginationIdx).toBeGreaterThan(-1);
		expect(pageSizeIdx).toBeGreaterThan(-1);
		expect(paginationIdx).toBeLessThan(pageSizeIdx);
	});
});

describe('history-page.yaml payload row expansion', () => {
	const yamlPath = join(__dirname, '../dsl-frontend/history-page.yaml');
	const doc = yaml.load(readFileSync(yamlPath, 'utf-8')) as YamlDoc;
	const dataTable = (doc.sections as Section[]).find((s) => s.$type === 'DataTable') as Section;
	const expansion = dataTable?.expansion as Section;

	it('DataTable only offers the expand toggle on rows that have a payloadText', () => {
		expect(dataTable.expansionCondition).toBe('payloadText');
	});

	it('expansion is a JsonViewer reading the payloadText field', () => {
		expect(expansion?.$type).toBe('JsonViewer');
		// A plain string: JsonViewer does String(row[field]), a "$"-prefixed value would be resolved as an expression.
		expect(expansion?.field).toBe('payloadText');
	});

	it('expansion passes the row explicitly (JsonViewer gets no row otherwise and renders an empty block)', () => {
		expect(expansion?.row).toBe('$ctx.row');
	});

	it('the toggle condition and the displayed field are the same key', () => {
		expect(dataTable.expansionCondition).toBe(expansion?.field);
	});

	it('shows an explicit empty state for a page without rows', () => {
		expect(dataTable.emptyMessage).toBe('No events recorded yet');
	});
});
