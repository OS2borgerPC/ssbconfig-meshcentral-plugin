import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Form from '@rjsf/mui';
import validator from '@rjsf/validator-ajv8';
import {
	Alert,
	Box,
	Button,
	Card,
	CardContent,
	List,
	ListItemButton,
	ListItemText,
	Stack,
	Tab,
	Tabs,
	TextField,
	Typography
} from '@mui/material';

function buildPluginUrl(query) {
	// Builds the plugin endpoint URL used for all admin API calls.
	return `./pluginadmin.ashx${query}`;
}

function normalizePath(input) {
	// Normalizes path separators and trims leading/trailing slashes.
	return String(input || '')
		.replace(/\\/g, '/')
		.replace(/^\/+/, '')
		.replace(/\/+$/, '');
}

function joinRepoPath(...parts) {
	// Joins repository path segments after normalization.
	return parts
		.map((part) => normalizePath(part))
		.filter(Boolean)
		.join('/');
}

function sanitizeFileName(name) {
	// Replaces unsafe filename characters with dashes.
	return String(name || '')
		.replace(/[\\/]/g, '-')
		.replace(/[^A-Za-z0-9._-]/g, '-');
}

function toBase64(buffer) {
	// Encodes an ArrayBuffer as base64 in chunks to avoid call stack limits.
	let binary = '';
	const bytes = new Uint8Array(buffer);
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode.apply(null, chunk);
	}
	return btoa(binary);
}

function ensureUploadStore() {
	// Initializes and returns the in-memory upload store on window.
	if (!window.__SSBCONFIG_UPLOADS__ || typeof window.__SSBCONFIG_UPLOADS__ !== 'object') {
		window.__SSBCONFIG_UPLOADS__ = {};
	}
	return window.__SSBCONFIG_UPLOADS__;
}

function collectUploadEntries() {
	// Converts the upload store object into an API-friendly list.
	const store = ensureUploadStore();
	return Object.entries(store).map(([path, content]) => ({ path, content }));
}

function isObject(value) {
	// Returns true only for plain object-like values.
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toRegex(pattern) {
	// Safely compiles a regex pattern, returning null on invalid input.
	if (typeof pattern !== 'string' || pattern.length === 0) return null;
	try {
		return new RegExp(pattern);
	} catch (_err) {
		return null;
	}
}

function matchesPattern(value, pattern) {
	// Validates a value against a regex pattern when provided.
	const regex = toRegex(pattern);
	if (!regex) return true;
	return regex.test(String(value || ''));
}

function resolveTemplatePath(template, fileName, fallbackPrefix) {
	// Resolves a path template and substitutes filename placeholders.
	const safeFileName = sanitizeFileName(fileName);
	const rawTemplate = String(template || '').trim();
	if (!rawTemplate) {
		const prefix = String(fallbackPrefix || '').replace(/\/+$/, '');
		return `${prefix}/${safeFileName}`;
	}

	const withReplacement = rawTemplate.replace(/\{\{\s*filename\s*\}\}|\{filename\}|\$\{filename\}/gi, safeFileName);
	if (withReplacement !== rawTemplate) {
		return withReplacement;
	}

	const prefix = rawTemplate.replace(/\/+$/, '');
	return `${prefix}/${safeFileName}`;
}

function getUiOptions(uiNode) {
	// Extracts ui:options from an RJSF uiSchema node.
	return isObject(uiNode) && isObject(uiNode['ui:options']) ? uiNode['ui:options'] : {};
}

async function parseApiResponse(response) {
	// Parses API responses and falls back to raw text errors.
	const raw = await response.text();
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch (e) {
		return { error: raw };
	}
}

function buildPolicyChoices(policies, policyFileOptions = {}, policyPattern = '') {
	// Builds policy dropdown choices filtered by optional pattern matching.
	return (Array.isArray(policies) ? policies : []).map((entry) => {
		const data = entry && typeof entry.content === 'object' ? entry.content : {};
		const fileName = String(entry?.path || '').split('/').pop() || 'policy.yml';
		const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : fileName;
		const referencePath = resolveTemplatePath(policyFileOptions.assetPrefixTemplate, fileName, '../policies');
		if (!matchesPattern(referencePath, policyPattern)) {
			return null;
		}
		return {
			path: referencePath,
			name
		};
	}).filter((item) => item && item.path);
}

function AssetFileWidget(props) {
	// RJSF custom widget that uploads a file and writes an asset path to the form.
	const { value, onChange, options = {}, label, id, required, schema = {}, rawErrors = [] } = props;
	const accept = options.accept || '*/*';
	const assetBasePath = normalizePath(options.assetBasePath || 'config/default/assets');
	const assetPrefixTemplate = options.assetPrefixTemplate || '/assets';
	const [localError, setLocalError] = useState('');

	return (
		<Box sx={{ mb: 2 }}>
			<label htmlFor={id} style={{ display: 'block', marginBottom: 8, fontWeight: 500 }}>
				{label}
				{required ? <span style={{ color: '#b00020' }}> *</span> : null}
			</label>
			<input
				id={id}
				type="file"
				accept={accept}
				onChange={async (event) => {
					const file = event.target.files && event.target.files[0];
					if (!file) return;
					const safeName = sanitizeFileName(file.name);
					const uploadPath = joinRepoPath(assetBasePath, safeName);
					const formPathValue = resolveTemplatePath(assetPrefixTemplate, safeName, '/assets');
					if (!matchesPattern(formPathValue, schema.pattern)) {
						setLocalError(`Selected path does not match pattern: ${schema.pattern}`);
						event.target.value = '';
						return;
					}
					const arrayBuffer = await file.arrayBuffer();
					const base64 = toBase64(arrayBuffer);
					const store = ensureUploadStore();
					store[uploadPath] = base64;
					setLocalError('');
					onChange(formPathValue);
					event.target.value = '';
				}}
			/>
			{localError ? (
				<Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'error.main' }}>
					{localError}
				</Typography>
			) : null}
			{!localError && rawErrors.length > 0 ? (
				<Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'error.main' }}>
					{rawErrors[0]}
				</Typography>
			) : null}
			{value ? (
				<Typography variant="caption" sx={{ display: 'block', mt: 1, fontFamily: 'monospace' }}>
					{String(value)}
				</Typography>
			) : null}
		</Box>
	);
}

function readCollapsibleOptions(uiSchema) {
	// Reads collapsible section options from ui:options.
	const options = uiSchema && typeof uiSchema === 'object' ? uiSchema['ui:options'] : null;
	return options && typeof options === 'object' ? options : {};
}

function CollapsibleSectionField(props) {
	// Renders object sections as optional collapsible UI blocks.
	const {
		idSchema,
		schema = {},
		uiSchema,
		registry,
		name
	} = props;

	const options = readCollapsibleOptions(uiSchema);
	const collapsible = options.collapsible !== false;
	const [collapsed, setCollapsed] = useState(options.collapsed === true);

	const title = useMemo(() => {
		if (typeof options.title === 'string' && options.title.trim().length > 0) {
			return options.title;
		}
		if (typeof schema.title === 'string' && schema.title.trim().length > 0) {
			return schema.title;
		}
		return name || 'Section';
	}, [name, options.title, schema.title]);

	const SchemaField = registry?.fields?.SchemaField;
	if (!SchemaField) {
		return null;
	}

	const childUiSchema = { ...(uiSchema || {}) };
	delete childUiSchema['ui:field'];

	return (
		<section className="ssb-collapsible-section" data-field-id={idSchema?.$id || ''}>
			<button
				type="button"
				onClick={() => collapsible && setCollapsed((value) => !value)}
				className="ssb-collapsible-section__header"
				aria-expanded={!collapsed}
				aria-controls={`${idSchema?.$id || 'section'}__content`}
				disabled={!collapsible}
				style={{
					width: '100%',
					display: 'flex',
					alignItems: 'center',
					gap: 8,
					padding: '8px 10px',
					border: '1px solid #d0d7e2',
					borderRadius: 6,
					background: '#f8fbff',
					cursor: collapsible ? 'pointer' : 'default',
					textAlign: 'left',
					marginBottom: 8,
					fontWeight: 600
				}}
			>
				<span className="ssb-collapsible-section__chevron" aria-hidden="true">
					{collapsed ? '▸' : '▾'}
				</span>
				<span className="ssb-collapsible-section__title">{title}</span>
			</button>

			{!collapsed ? (
				<div id={`${idSchema?.$id || 'section'}__content`} className="ssb-collapsible-section__content">
					<SchemaField
						{...props}
						uiSchema={childUiSchema}
					/>
				</div>
			) : null}
		</section>
	);
}

function listItemLabel(entry, fallbackPrefix, index) {
	// Chooses the display label for policy/imageconfig list entries.
	const content = entry && typeof entry.content === 'object' ? entry.content : {};
	if (typeof content.name === 'string' && content.name.trim()) return content.name.trim();
	return entry?.fileName || `${fallbackPrefix} ${index + 1}`;
}

function applyPolicyUiEnhancements(uiNode, context) {
	// Recursively applies policy-specific uiSchema widget enhancements.
	if (Array.isArray(uiNode)) {
		return uiNode.map((entry) => applyPolicyUiEnhancements(entry, context));
	}

	if (!isObject(uiNode)) {
		return uiNode;
	}

	const next = { ...uiNode };
	Object.keys(next).forEach((key) => {
		next[key] = applyPolicyUiEnhancements(next[key], context);
	});

	const options = getUiOptions(next);
	const assetFile = isObject(options.assetFile) ? options.assetFile : null;
	if (assetFile) {
		next['ui:widget'] = 'assetFileWidget';
		next['ui:options'] = {
			...options,
			accept: typeof assetFile.accept === 'string' ? assetFile.accept : (options.accept || '*/*'),
			assetPrefixTemplate: typeof assetFile.assetPrefixTemplate === 'string' ? assetFile.assetPrefixTemplate : (options.assetPrefixTemplate || '/assets'),
			assetBasePath: context.assetBasePath
		};
	}

	return next;
}

function applyImageUiEnhancements(schemaNode, uiNode, context) {
	// Recursively prepares image uiSchema structure to mirror schema shape.
	const next = isObject(uiNode) ? { ...uiNode } : {};

	if (isObject(schemaNode) && schemaNode.type === 'object' && isObject(schemaNode.properties)) {
		Object.entries(schemaNode.properties).forEach(([propName, propSchema]) => {
			next[propName] = applyImageUiEnhancements(propSchema, next[propName], context);
		});
	}

	if (isObject(schemaNode) && schemaNode.type === 'array') {
		const itemSchema = Array.isArray(schemaNode.items) ? schemaNode.items[0] : schemaNode.items;
		next.items = applyImageUiEnhancements(itemSchema, next.items, context);
	}

	return next;
}

function findPolicyFileConfig(schemaNode, uiNode) {
	// Finds policy file reference configuration from nested schema/uiSchema nodes.
	if (!isObject(schemaNode)) return null;

	if (schemaNode.type === 'array') {
		const itemSchema = Array.isArray(schemaNode.items) ? schemaNode.items[0] : schemaNode.items;
		const ownOptions = getUiOptions(uiNode);
		const itemsUi = isObject(uiNode) ? uiNode.items : undefined;
		const itemOptions = getUiOptions(itemsUi);
		const policyFile = isObject(ownOptions.policyFile) ? ownOptions.policyFile : (isObject(itemOptions.policyFile) ? itemOptions.policyFile : null);
		if (policyFile) {
			return {
				options: policyFile,
				pattern: typeof itemSchema?.pattern === 'string' ? itemSchema.pattern : ''
			};
		}
	}

	if (schemaNode.type === 'object' && isObject(schemaNode.properties)) {
		for (const [propName, propSchema] of Object.entries(schemaNode.properties)) {
			const found = findPolicyFileConfig(propSchema, isObject(uiNode) ? uiNode[propName] : undefined);
			if (found) return found;
		}
	}

	if (schemaNode.type === 'array') {
		const itemSchema = Array.isArray(schemaNode.items) ? schemaNode.items[0] : schemaNode.items;
		return findPolicyFileConfig(itemSchema, isObject(uiNode) ? uiNode.items : undefined);
	}

	return null;
}

function App() {
	// Root admin application component for loading, editing, validating, and saving configs.
	const injectedDomainId = typeof window !== 'undefined' && typeof window.__SSBCONFIG_DOMAIN_ID__ === 'string'
		? window.__SSBCONFIG_DOMAIN_ID__
		: '';

	const [loading, setLoading] = useState(true);
	const [previewing, setPreviewing] = useState(false);
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState({ type: 'info', message: 'Loading data from GitHub...' });

	const [domainId, setDomainId] = useState(injectedDomainId);
	const [branch, setBranch] = useState('');
	const [domainPaths, setDomainPaths] = useState({ policiesPath: '', imageconfigsPath: '', assetsPath: '' });

	const [policiesSchema, setPoliciesSchema] = useState({ type: 'object', properties: {} });
	const [policiesUiSchema, setPoliciesUiSchema] = useState({});
	const [imageSchema, setImageSchema] = useState({ type: 'object', properties: {} });
	const [imageUiSchema, setImageUiSchema] = useState({});

	const [policies, setPolicies] = useState([]);
	const [imageconfigs, setImageconfigs] = useState([]);
	const [selectedPolicy, setSelectedPolicy] = useState(0);
	const [selectedImageconfig, setSelectedImageconfig] = useState(0);
	const [activeTab, setActiveTab] = useState('policies');
	const [validationErrors, setValidationErrors] = useState([]);
	const [commitMessage, setCommitMessage] = useState('Update policies/imageconfigs from MeshCentral');

	const customWidgets = useMemo(() => ({
		assetFileWidget: AssetFileWidget
	}), []);

	const policyFileConfig = useMemo(() => findPolicyFileConfig(imageSchema, imageUiSchema), [imageSchema, imageUiSchema]);
	const policyChoices = useMemo(
		() => buildPolicyChoices(policies, policyFileConfig?.options || {}, policyFileConfig?.pattern || ''),
		[policies, policyFileConfig]
	);

	const customFields = useMemo(() => ({
		collapsibleSection: CollapsibleSectionField,
		CollapsibleSectionField: CollapsibleSectionField
	}), []);

	const effectivePoliciesUiSchema = useMemo(
		() => applyPolicyUiEnhancements(policiesUiSchema, { assetBasePath: domainPaths.assetsPath }),
		[policiesUiSchema, domainPaths.assetsPath]
	);
	const effectiveImageUiSchema = useMemo(
		() => applyImageUiEnhancements(imageSchema, imageUiSchema, { policyChoices }),
		[imageSchema, imageUiSchema, policyChoices]
	);

	// Normalizes backend entries into a consistent local editing model.
	const normalizeEntries = (entries, baseDir) => {
		const list = Array.isArray(entries) ? entries : [];
		return list.map((entry, index) => {
			const filePath = normalizePath(entry.path || joinRepoPath(baseDir, `item-${index + 1}.yml`));
			return {
				path: filePath,
				fileName: filePath.split('/').pop() || `item-${index + 1}.yml`,
				sha: typeof entry.sha === 'string' ? entry.sha : '',
				content: entry.content && typeof entry.content === 'object' ? entry.content : {}
			};
		});
	};

	async function fetchBootstrap() {
		// Loads schemas and domain files from the backend bootstrap endpoint.
		setLoading(true);
		setStatus({ type: 'info', message: 'Loading data from GitHub...' });

		try {
			const response = await fetch(buildPluginUrl('?pin=ssbconfig&api=bootstrap&user=1'));
			const payload = await parseApiResponse(response);
			if (!response.ok) throw new Error(payload.error || 'Bootstrap failed');

			setDomainId(typeof payload.domainId === 'string' ? payload.domainId : injectedDomainId);
			setBranch(typeof payload.branch === 'string' ? payload.branch : '');
			setDomainPaths(payload.domainPaths || { policiesPath: '', imageconfigsPath: '', assetsPath: '' });

			const schemas = payload.schemas || {};
			setPoliciesSchema(schemas.policiesSchema || { type: 'object', properties: {} });
			setPoliciesUiSchema(schemas.policiesUiSchema || {});
			setImageSchema(schemas.imageconfigsSchema || { type: 'object', properties: {} });
			setImageUiSchema(schemas.imageconfigsUiSchema || {});

			const normalizedPolicies = normalizeEntries(payload.policies, payload?.domainPaths?.policiesPath || '');
			const normalizedImageconfigs = normalizeEntries(payload.imageconfigs, payload?.domainPaths?.imageconfigsPath || '');

			setPolicies(normalizedPolicies);
			setImageconfigs(normalizedImageconfigs);
			setSelectedPolicy(0);
			setSelectedImageconfig(0);
			setValidationErrors([]);
			ensureUploadStore();
			window.__SSBCONFIG_UPLOADS__ = {};

			setStatus({
				type: 'success',
				message: `Loaded ${normalizedPolicies.length} policies and ${normalizedImageconfigs.length} imageconfigs for domain ${payload.domainId || 'default'}.`
			});
		} catch (err) {
			setStatus({ type: 'error', message: err.message || 'Failed to load bootstrap data' });
		} finally {
			setLoading(false);
		}
	}

	React.useEffect(() => {
		fetchBootstrap();
	}, []);

	function updateEntry(list, index, nextEntry) {
		// Replaces a single entry by index in an immutable way.
		const next = [...list];
		next[index] = nextEntry;
		return next;
	}

	function createNewEntry(type) {
		// Creates a new unsaved policy or imageconfig entry scaffold.
		const baseDir = type === 'policies' ? domainPaths.policiesPath : domainPaths.imageconfigsPath;
		const now = Date.now();
		const fileName = `${type === 'policies' ? 'policy' : 'imageconfig'}-${now}.yml`;
		return {
			path: joinRepoPath(baseDir, fileName),
			fileName,
			sha: '',
			content: {}
		};
	}

	async function runPreviewOrSave(api) {
		// Sends preview or save requests and updates validation/commit status.
		const body = {
			policies: policies.map((entry) => ({ path: entry.path, content: entry.content })),
			imageconfigs: imageconfigs.map((entry) => ({ path: entry.path, content: entry.content })),
			assets: collectUploadEntries(),
			commitMessage
		};

		const isPreview = api === 'preview';
		if (isPreview) setPreviewing(true);
		else setSaving(true);

		setStatus({ type: 'info', message: isPreview ? 'Validating against schemas...' : 'Committing to GitHub...' });

		try {
			const response = await fetch(buildPluginUrl(`?pin=ssbconfig&api=${api}&user=1`), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});

			const payload = await parseApiResponse(response);
			if (!response.ok) throw new Error(payload.error || `${api} failed`);

			const errors = Array.isArray(payload.validationErrors) ? payload.validationErrors : [];
			setValidationErrors(errors);

			if (errors.length > 0) {
				setStatus({
					type: 'error',
					message: `Validation failed with ${errors.length} file-level error(s).`
				});
				return;
			}

			if (api === 'save' && payload.commitSha) {
				setStatus({
					type: 'success',
					message: `Committed ${payload.changedFiles ? payload.changedFiles.length : 0} file(s) to ${payload.branch}. Commit: ${payload.commitSha}`
				});
				window.__SSBCONFIG_UPLOADS__ = {};
			} else {
				setStatus({ type: 'success', message: 'Preview validation passed.' });
			}
		} catch (err) {
			setStatus({ type: 'error', message: err.message || `${api} failed` });
		} finally {
			if (isPreview) setPreviewing(false);
			else setSaving(false);
		}
	}

	function renderEditorTab(type) {
		// Renders the list and form editor for either policies or imageconfigs.
		const isPolicies = type === 'policies';
		const items = isPolicies ? policies : imageconfigs;
		const setItems = isPolicies ? setPolicies : setImageconfigs;
		const selected = isPolicies ? selectedPolicy : selectedImageconfig;
		const setSelected = isPolicies ? setSelectedPolicy : setSelectedImageconfig;
		const schema = isPolicies ? policiesSchema : imageSchema;
		const uiSchema = isPolicies ? effectivePoliciesUiSchema : effectiveImageUiSchema;
		const labelPrefix = isPolicies ? 'Policy' : 'Imageconfig';

		const selectedItem = items[selected] || null;

		return (
			<Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: 2 }}>
				<Box sx={{ width: { xs: '100%', md: 320 }, flexShrink: 0, border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1 }}>
					<Stack spacing={1}>
						<Typography variant="subtitle2">{isPolicies ? 'Policies' : 'Imageconfigs'}</Typography>
						<List dense disablePadding>
							{items.map((entry, idx) => (
								<ListItemButton
									key={`${entry.path}-${idx}`}
									selected={idx === selected}
									onClick={() => setSelected(idx)}
									sx={{ borderRadius: 1, mb: 0.5 }}
								>
									<ListItemText
										primary={listItemLabel(entry, labelPrefix, idx)}
									/>
								</ListItemButton>
							))}
						</List>
						<Stack direction="row" spacing={1}>
							<Button
								size="small"
								variant="outlined"
								onClick={() => {
									const next = [...items, createNewEntry(type)];
									setItems(next);
									setSelected(next.length - 1);
								}}
							>
								Add
							</Button>
							<Button
								size="small"
								color="error"
								variant="outlined"
								disabled={items.length === 0}
								onClick={() => {
									const next = items.filter((_item, idx) => idx !== selected);
									setItems(next);
									setSelected(Math.max(0, selected - 1));
								}}
							>
								Delete
							</Button>
						</Stack>
					</Stack>
				</Box>

				<Box sx={{ flex: 1, minWidth: 0 }}>
					{!selectedItem ? (
						<Typography variant="body2" color="text.secondary">Select a file from the list.</Typography>
					) : (
						<Stack spacing={2}>
							<TextField
								fullWidth
								label="File name"
								value={selectedItem.fileName}
								onChange={(event) => {
									const nextFileName = sanitizeFileName(event.target.value);
									const baseDir = isPolicies ? domainPaths.policiesPath : domainPaths.imageconfigsPath;
									const updated = {
										...selectedItem,
										fileName: nextFileName,
										path: joinRepoPath(baseDir, nextFileName)
									};
									setItems(updateEntry(items, selected, updated));
								}}
							/>

							<Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
								{selectedItem.path}
							</Typography>

							<Form
								schema={schema}
								uiSchema={uiSchema}
								formData={selectedItem.content}
								validator={validator}
								widgets={customWidgets}
								fields={customFields}
								noHtml5Validate
								liveValidate={false}
								showErrorList={false}
								onChange={({ formData }) => {
									const updated = { ...selectedItem, content: formData && typeof formData === 'object' ? formData : {} };
									setItems(updateEntry(items, selected, updated));
								}}
							>
								<div />
							</Form>
						</Stack>
					)}
				</Box>
			</Box>
		);
	}

	return (
		<Box sx={{ p: 2, backgroundColor: '#f4f6fa', minHeight: '100vh' }}>
			<Stack spacing={2}>
				<Card>
					<CardContent>
						<Typography variant="h5">Sikker Selvbetjening Config Editor</Typography>
						<Typography variant="body2" color="text.secondary">
							Domain-aware GitHub editor for policies and imageconfigs.
						</Typography>
						<Typography variant="caption" sx={{ display: 'block', mt: 1, fontFamily: 'monospace' }}>
							Domain: {domainId || 'default'} | Branch: {branch || '-'}
						</Typography>
						<Typography variant="caption" sx={{ display: 'block', mt: 0.5, fontFamily: 'monospace' }}>
							Policies: {domainPaths.policiesPath || '-'}
						</Typography>
						<Typography variant="caption" sx={{ display: 'block', mt: 0.5, fontFamily: 'monospace' }}>
							Imageconfigs: {domainPaths.imageconfigsPath || '-'}
						</Typography>
						<Typography variant="caption" sx={{ display: 'block', mt: 0.5, fontFamily: 'monospace' }}>
							Assets: {domainPaths.assetsPath || '-'}
						</Typography>
					</CardContent>
				</Card>

				<Alert severity={status.type === 'error' ? 'error' : status.type === 'success' ? 'success' : 'info'}>
					<Typography variant="body2">{status.message}</Typography>
				</Alert>

				{validationErrors.length > 0 ? (
					<Alert severity="error">
						<Stack spacing={0.5}>
							<Typography variant="body2">Validation errors</Typography>
							{validationErrors.map((entry, idx) => (
								<Box key={`${entry.path || idx}-${idx}`}>
									<Typography variant="caption" sx={{ fontFamily: 'monospace', display: 'block' }}>
										{entry.path || `item-${idx + 1}`}
									</Typography>
									{(Array.isArray(entry.errors) ? entry.errors : []).map((err, errIdx) => (
										<Typography key={`${idx}-${errIdx}`} variant="caption" sx={{ fontFamily: 'monospace', display: 'block', ml: 2 }}>
											{err.text || err.message || 'Unknown error'}
										</Typography>
									))}
								</Box>
							))}
						</Stack>
					</Alert>
				) : null}

				<Card>
					<CardContent>
						<Tabs
							value={activeTab}
							onChange={(_event, value) => setActiveTab(value)}
							variant="scrollable"
							allowScrollButtonsMobile
						>
							<Tab value="policies" label="Policies" />
							<Tab value="imageconfigs" label="Imageconfigs" />
						</Tabs>

						<Box sx={{ mt: 2 }}>
							{activeTab === 'policies' ? renderEditorTab('policies') : renderEditorTab('imageconfigs')}
						</Box>
					</CardContent>
				</Card>

				<Card>
					<CardContent>
						<Typography variant="h6" sx={{ mb: 2 }}>Validation + Save</Typography>

						<Stack spacing={2}>
							<TextField
								fullWidth
								label="Commit message"
								value={commitMessage}
								onChange={(event) => setCommitMessage(event.target.value)}
							/>

							<Stack direction="row" spacing={1}>
								<Button
									variant="contained"
									disabled={loading || previewing || saving}
									onClick={() => runPreviewOrSave('preview')}
								>
									{previewing ? 'Validating...' : 'Preview + Validate'}
								</Button>

								<Button
									variant="contained"
									color="success"
									disabled={loading || previewing || saving}
									onClick={() => runPreviewOrSave('save')}
								>
									{saving ? 'Saving...' : 'Commit to GitHub'}
								</Button>

								<Button variant="outlined" disabled={loading || previewing || saving} onClick={fetchBootstrap}>
									Reload
								</Button>
							</Stack>
						</Stack>
					</CardContent>
				</Card>
			</Stack>
		</Box>
	);
}

const rootNode = document.getElementById('ssbconfig-root');
if (rootNode) {
	// Mounts the React app into the plugin admin root element.
	const root = createRoot(rootNode);
	root.render(<App />);
}
