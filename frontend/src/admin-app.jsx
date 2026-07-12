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
	MenuItem,
	Stack,
	Tab,
	Tabs,
	TextField,
	Typography
} from '@mui/material';

function buildPluginUrl(query) {
	return `./pluginadmin.ashx${query}`;
}

function normalizePath(input) {
	return String(input || '')
		.replace(/\\/g, '/')
		.replace(/^\/+/, '')
		.replace(/\/+$/, '');
}

function joinRepoPath(...parts) {
	return parts
		.map((part) => normalizePath(part))
		.filter(Boolean)
		.join('/');
}

function sanitizeFileName(name) {
	const cleaned = String(name || 'new-file.yml')
		.replace(/[\\/]/g, '-')
		.replace(/[^A-Za-z0-9._-]/g, '-');
	if (cleaned.toLowerCase().endsWith('.yml') || cleaned.toLowerCase().endsWith('.yaml') || cleaned.toLowerCase().endsWith('.json')) {
		return cleaned;
	}
	return `${cleaned}.yml`;
}

function toBase64(buffer) {
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
	if (!window.__SSBCONFIG_UPLOADS__ || typeof window.__SSBCONFIG_UPLOADS__ !== 'object') {
		window.__SSBCONFIG_UPLOADS__ = {};
	}
	return window.__SSBCONFIG_UPLOADS__;
}

function collectUploadEntries() {
	const store = ensureUploadStore();
	return Object.entries(store).map(([path, content]) => ({ path, content }));
}

async function parseApiResponse(response) {
	const raw = await response.text();
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch (e) {
		return { error: raw };
	}
}

function buildPolicyChoices(policies) {
	return (Array.isArray(policies) ? policies : []).map((entry) => {
		const data = entry && typeof entry.content === 'object' ? entry.content : {};
		const fallback = String(entry?.path || '').split('/').pop() || 'policy.yml';
		const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : fallback;
		return {
			path: String(entry?.path || ''),
			name
		};
	}).filter((item) => item.path);
}

function AssetFileWidget(props) {
	const { value, onChange, options = {}, label, id, required } = props;
	const accept = options.accept || '*/*';
	const assetBasePath = normalizePath(options.assetBasePath || 'config/default/assets');

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
					const pathValue = joinRepoPath(assetBasePath, safeName);
					const arrayBuffer = await file.arrayBuffer();
					const base64 = toBase64(arrayBuffer);
					const store = ensureUploadStore();
					store[pathValue] = base64;
					onChange(pathValue);
					event.target.value = '';
				}}
			/>
			{value ? (
				<Typography variant="caption" sx={{ display: 'block', mt: 1, fontFamily: 'monospace' }}>
					{String(value)}
				</Typography>
			) : null}
		</Box>
	);
}

function PolicyReferenceField(props) {
	const { formData, onChange, uiSchema = {}, label, required, readonly, disabled, rawErrors = [] } = props;
	const options = uiSchema['ui:options'] || {};
	const choices = Array.isArray(options.policies) ? options.policies : [];

	const byPath = new Map(choices.map((entry) => [entry.path, entry.name]));
	const selected = Array.isArray(formData) ? formData.filter((v) => typeof v === 'string' && v.length > 0) : [];

	return (
		<TextField
			select
			fullWidth
			size="small"
			label={label || 'Policies'}
			required={required}
			value={selected}
			disabled={Boolean(readonly || disabled)}
			onChange={(event) => {
				const raw = event.target.value;
				onChange(Array.isArray(raw) ? raw : String(raw || '').split(',').filter(Boolean));
			}}
			SelectProps={{
				multiple: true,
				renderValue: (selectedValues) => {
					const values = Array.isArray(selectedValues) ? selectedValues : [];
					if (!values.length) return 'Select policies';
					return values.map((item) => byPath.get(item) || item).join(', ');
				}
			}}
			helperText={rawErrors.length > 0 ? rawErrors[0] : 'Selected policy names are displayed, but policy file paths are stored.'}
			sx={{ mb: 2 }}
		>
			{choices.map((entry) => (
				<MenuItem key={entry.path} value={entry.path}>{entry.name}</MenuItem>
			))}
			{selected.filter((pathValue) => !byPath.has(pathValue)).map((pathValue) => (
				<MenuItem key={`missing-${pathValue}`} value={pathValue}>Missing: {pathValue}</MenuItem>
			))}
		</TextField>
	);
}

function listItemLabel(entry, fallbackPrefix, index) {
	const content = entry && typeof entry.content === 'object' ? entry.content : {};
	if (typeof content.name === 'string' && content.name.trim()) return content.name.trim();
	return entry?.fileName || `${fallbackPrefix} ${index + 1}`;
}

function applyPolicyUiEnhancements(baseUiSchema, assetBasePath) {
	const next = (baseUiSchema && typeof baseUiSchema === 'object') ? { ...baseUiSchema } : {};

	if (!next.desktop || typeof next.desktop !== 'object') next.desktop = {};
	next.desktop = {
		...next.desktop,
		background_image_file: {
			...(next.desktop.background_image_file && typeof next.desktop.background_image_file === 'object' ? next.desktop.background_image_file : {}),
			'ui:widget': 'assetFileWidget',
			'ui:options': {
				...(
					next.desktop.background_image_file &&
					typeof next.desktop.background_image_file === 'object' &&
					next.desktop.background_image_file['ui:options'] &&
					typeof next.desktop.background_image_file['ui:options'] === 'object'
						? next.desktop.background_image_file['ui:options']
						: {}
				),
				assetBasePath
			}
		}
	};

	if (!next.printers || typeof next.printers !== 'object') next.printers = {};
	if (!next.printers.items || typeof next.printers.items !== 'object') next.printers.items = {};
	next.printers = {
		...next.printers,
		items: {
			...next.printers.items,
			ppd_file: {
				...(next.printers.items.ppd_file && typeof next.printers.items.ppd_file === 'object' ? next.printers.items.ppd_file : {}),
				'ui:widget': 'assetFileWidget',
				'ui:options': {
					...(
						next.printers.items.ppd_file &&
						typeof next.printers.items.ppd_file === 'object' &&
						next.printers.items.ppd_file['ui:options'] &&
						typeof next.printers.items.ppd_file['ui:options'] === 'object'
							? next.printers.items.ppd_file['ui:options']
							: {}
					),
					assetBasePath
				}
			}
		}
	};

	return next;
}

function applyImageUiEnhancements(baseUiSchema, policyChoices) {
	const next = (baseUiSchema && typeof baseUiSchema === 'object') ? { ...baseUiSchema } : {};
	next.policies = {
		...(next.policies && typeof next.policies === 'object' ? next.policies : {}),
		'ui:field': 'policyReferenceSelect',
		'ui:options': {
			...(
				next.policies &&
				typeof next.policies === 'object' &&
				next.policies['ui:options'] &&
				typeof next.policies['ui:options'] === 'object'
					? next.policies['ui:options']
					: {}
			),
			policies: policyChoices
		}
	};
	return next;
}

function App() {
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

	const policyChoices = useMemo(() => buildPolicyChoices(policies), [policies]);

	const customFields = useMemo(() => ({
		policyReferenceSelect: PolicyReferenceField
	}), []);

	const effectivePoliciesUiSchema = useMemo(() => applyPolicyUiEnhancements(policiesUiSchema, domainPaths.assetsPath), [policiesUiSchema, domainPaths.assetsPath]);
	const effectiveImageUiSchema = useMemo(() => applyImageUiEnhancements(imageUiSchema, policyChoices), [imageUiSchema, policyChoices]);

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
		const next = [...list];
		next[index] = nextEntry;
		return next;
	}

	function createNewEntry(type) {
		const baseDir = type === 'policies' ? domainPaths.policiesPath : domainPaths.imageconfigsPath;
		const now = Date.now();
		const fileName = `${type}-${now}.yml`;
		return {
			path: joinRepoPath(baseDir, fileName),
			fileName,
			sha: '',
			content: {}
		};
	}

	async function runPreviewOrSave(api) {
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
	const root = createRoot(rootNode);
	root.render(<App />);
}
