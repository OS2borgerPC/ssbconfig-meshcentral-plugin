import React, { useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Form from '@rjsf/mui';
import validator from '@rjsf/validator-ajv8';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Stack,
  TextField,
  Typography
} from '@mui/material';

function normalizePath(input) {
  return String(input || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
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

function buildPluginUrl(queryString) {
  return `./pluginadmin.ashx${queryString}`;
}

function resolveJsonPointer(root, ref) {
  if (!root || typeof root !== 'object' || typeof ref !== 'string' || !ref.startsWith('#/')) {
    return null;
  }

  const tokens = ref
    .slice(2)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));

  let current = root;
  for (const token of tokens) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, token)) {
      return null;
    }
    current = current[token];
  }

  return current;
}

function mergeSchemas(base, extension) {
  const next = { ...(base || {}) };
  const extra = extension && typeof extension === 'object' ? extension : {};

  if (extra.type && !next.type) next.type = extra.type;
  if (extra.properties && typeof extra.properties === 'object') {
    next.properties = { ...(next.properties || {}), ...extra.properties };
  }
  if (extra.items && !next.items) next.items = extra.items;
  if (Object.prototype.hasOwnProperty.call(extra, 'additionalProperties') && !Object.prototype.hasOwnProperty.call(next, 'additionalProperties')) {
    next.additionalProperties = extra.additionalProperties;
  }
  if (extra['x-ssb-file'] && typeof extra['x-ssb-file'] === 'object') {
    next['x-ssb-file'] = { ...(next['x-ssb-file'] || {}), ...extra['x-ssb-file'] };
  }

  return next;
}

function getEffectiveSchema(rootSchema, schemaNode, seenRefs = new Set()) {
  if (!schemaNode || typeof schemaNode !== 'object') {
    return {};
  }

  let resolved = { ...schemaNode };

  if (typeof resolved.$ref === 'string') {
    const ref = resolved.$ref;
    if (!seenRefs.has(ref)) {
      seenRefs.add(ref);
      const refSchema = resolveJsonPointer(rootSchema, ref);
      const expandedRef = getEffectiveSchema(rootSchema, refSchema, seenRefs);
      const withoutRef = { ...resolved };
      delete withoutRef.$ref;
      resolved = mergeSchemas(expandedRef, withoutRef);
    }
  }

  if (Array.isArray(resolved.allOf)) {
    let merged = { ...resolved };
    delete merged.allOf;
    for (const part of resolved.allOf) {
      const expandedPart = getEffectiveSchema(rootSchema, part, new Set(seenRefs));
      merged = mergeSchemas(merged, expandedPart);
    }
    resolved = merged;
  }

  return resolved;
}

function getFileFieldConfig(rootSchema, schemaNode) {
  const effectiveSchema = getEffectiveSchema(rootSchema, schemaNode);
  const cfg = effectiveSchema && typeof effectiveSchema['x-ssb-file'] === 'object'
    ? effectiveSchema['x-ssb-file']
    : null;

  if (!cfg || cfg.enabled !== true) {
    return null;
  }

  return cfg;
}

function getRepoContext() {
  if (typeof window === 'undefined' || !window.__SSBCONFIG_REPO_CONTEXT__ || typeof window.__SSBCONFIG_REPO_CONTEXT__ !== 'object') {
    return null;
  }
  return window.__SSBCONFIG_REPO_CONTEXT__;
}

function buildDownloadUrlFromTemplate(template, pathValue) {
  const repo = getRepoContext();
  if (!repo || !template || !pathValue) {
    return null;
  }

  return String(template)
    .replace('{owner}', encodeURIComponent(String(repo.owner || '').trim()))
    .replace('{repo}', encodeURIComponent(String(repo.repo || '').trim()))
    .replace('{branch}', encodeURIComponent(String(repo.branch || '').trim()))
    .replace('{path}', String(pathValue || '').split('/').map((s) => encodeURIComponent(s)).join('/'));
}

function resolveAssetPrefix(assetPrefixTemplate, domainId) {
  const rawDomain = String(domainId || '').trim();
  const safeDomain = /^[a-z][a-z0-9-_]*$/.test(rawDomain) ? rawDomain : 'default';
  const template = String(assetPrefixTemplate || 'config/assets/{domain}/');
  return template.replace('{domain}', safeDomain);
}

function ensureUploadedFilesStore() {
  if (!window.__SSBCONFIG_UPLOADED_FILES__ || typeof window.__SSBCONFIG_UPLOADED_FILES__ !== 'object') {
    window.__SSBCONFIG_UPLOADED_FILES__ = {};
  }
  return window.__SSBCONFIG_UPLOADED_FILES__;
}

function sanitizeUploadedFileName(fileName) {
  return String(fileName || 'upload.bin')
    .replace(/[\\/]/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '_');
}

function parseBase64DataUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('data:')) {
    return null;
  }

  const nameMatch = value.match(/;name=([^;]+)/i);
  const base64Match = value.match(/^data:[^,]*;base64,(.+)$/i);
  if (!base64Match || !base64Match[1]) {
    return null;
  }

  return {
    fileName: sanitizeUploadedFileName(nameMatch ? decodeURIComponent(nameMatch[1]) : 'upload.bin'),
    base64Content: base64Match[1]
  };
}

function normalizeSchemaDrivenFileData(formData, rootSchema, domainId) {
  if (!formData || typeof formData !== 'object') {
    return formData;
  }

  const uploadedFiles = ensureUploadedFilesStore();

  function walk(value, schemaNode) {
    const effectiveSchema = getEffectiveSchema(rootSchema, schemaNode);
    const fileConfig = getFileFieldConfig(rootSchema, effectiveSchema);
    if (fileConfig && typeof value === 'string' && !value.startsWith('config/assets/')) {
      const parsedDataUrl = parseBase64DataUrl(value);
      if (parsedDataUrl) {
        const assetPrefix = resolveAssetPrefix(fileConfig.assetPrefixTemplate, domainId);
        const pathValue = `${assetPrefix}${parsedDataUrl.fileName}`;
        uploadedFiles[pathValue] = parsedDataUrl.base64Content;
        return pathValue;
      }
    }

    if (Array.isArray(value)) {
      const itemSchema = effectiveSchema && effectiveSchema.items ? effectiveSchema.items : {};
      return value.map((item) => walk(item, itemSchema));
    }

    if (value && typeof value === 'object') {
      const output = {};
      const properties = effectiveSchema && effectiveSchema.properties && typeof effectiveSchema.properties === 'object'
        ? effectiveSchema.properties
        : {};
      const additionalProperties = effectiveSchema ? effectiveSchema.additionalProperties : undefined;

      for (const key of Object.keys(value)) {
        const childSchema = Object.prototype.hasOwnProperty.call(properties, key)
          ? properties[key]
          : (additionalProperties && typeof additionalProperties === 'object' ? additionalProperties : {});
        output[key] = walk(value[key], childSchema);
      }

      return output;
    }

    return value;
  }

  return walk(formData, rootSchema);
}

async function parseApiResponse(response) {
  const raw = await response.text();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    return {
      error: raw.length > 600 ? `${raw.slice(0, 600)}...` : raw
    };
  }
}

// Custom file upload widget for RJSF
function FileWidget(props) {
  const {
    value,
    onChange,
    options = {},
    label,
    id,
    required,
    schema = {},
    registry = {}
  } = props;

  const fileInputRef = useRef(null);
  const rootSchema = registry && registry.rootSchema ? registry.rootSchema : schema;
  const fileFieldCfg = getFileFieldConfig(rootSchema, schema) || {};
  const assetPrefixTemplate = fileFieldCfg.assetPrefixTemplate || options.assetPrefixTemplate || 'config/assets/{domain}/';
  const accept = fileFieldCfg.accept || options.accept || '*/*';
  const downloadUrlTemplate = fileFieldCfg.downloadUrlTemplate || null;

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const arrayBuffer = await file.arrayBuffer();
      const base64Content = toBase64(arrayBuffer);
      const uploadedFiles = ensureUploadedFilesStore();
      const fileName = sanitizeUploadedFileName(file.name);
      const activeDomainId =
        typeof window !== 'undefined' && typeof window.__SSBCONFIG_DOMAIN_ID__ === 'string'
          ? window.__SSBCONFIG_DOMAIN_ID__
          : '';
      const assetPrefix = resolveAssetPrefix(assetPrefixTemplate, activeDomainId);
      const pathValue = `${assetPrefix}${fileName}`;
      uploadedFiles[pathValue] = base64Content;
      onChange(pathValue);
      
      // Reset the input so selecting the same file again triggers change
      event.target.value = '';
    } catch (err) {
      console.error('Error reading file:', err);
    }
  };

  const fileName = value ? value.split('/').pop() : null;
  const hasFile = value && value.startsWith('config/assets/');
  const downloadUrl = hasFile ? buildDownloadUrlFromTemplate(downloadUrlTemplate, value) : null;

  return (
    <Box sx={{ mb: 2 }}>
      <label htmlFor={id} style={{ display: 'block', marginBottom: '8px', fontWeight: 500 }}>
        {label}
        {required && <span style={{ color: 'red' }}> *</span>}
      </label>
      <input
        ref={fileInputRef}
        id={id}
        type="file"
        accept={accept}
        onChange={handleFileChange}
        style={{ marginBottom: '8px', display: 'block' }}
      />
      {hasFile && (
        <Stack spacing={0.5} sx={{ mt: 1 }}>
          <Typography variant="caption" sx={{ color: 'green', display: 'block' }}>
            Current file: {fileName}
          </Typography>
          {downloadUrl ? (
            <Typography variant="caption" sx={{ display: 'block' }}>
              <a href={downloadUrl} target="_blank" rel="noopener noreferrer" download={fileName || undefined}>
                Download from GitHub
              </a>
            </Typography>
          ) : null}
        </Stack>
      )}
      {value && !hasFile && (
        <Typography variant="caption" sx={{ color: 'gray', display: 'block', mt: 1 }}>
          Value: {value}
        </Typography>
      )}
    </Box>
  );
}

function App() {
  const submitButtonRef = useRef(null);
  const injectedDomainId = typeof window !== 'undefined' && typeof window.__SSBCONFIG_DOMAIN_ID__ === 'string'
    ? window.__SSBCONFIG_DOMAIN_ID__
    : '';
  const [status, setStatus] = useState({ type: 'info', message: 'Loading config from GitHub...' });
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [repoInfo, setRepoInfo] = useState('');
  const [previewContent, setPreviewContent] = useState('');
  const [previewErrors, setPreviewErrors] = useState([]);

  const [schema, setSchema] = useState(null);
  const [uiSchema, setUiSchema] = useState(null);
  const [data, setData] = useState({});
  const [configFileSha, setConfigFileSha] = useState('');

  const [domainId, setDomainId] = useState(injectedDomainId);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [commitMessage, setCommitMessage] = useState('Update config and assets from MeshCentral plugin');

  const assetPathInfo = useMemo(() => {
    if (!domainId) return 'Assets path in repo: assets/(default)/...';
    return `Assets path in repo: assets/${domainId}/...`;
  }, [domainId]);

  // Extract uploaded files from window and prepare for commit
  const getUploadedFiles = () => {
    if (!window.__SSBCONFIG_UPLOADED_FILES__ || typeof window.__SSBCONFIG_UPLOADED_FILES__ !== 'object') {
      return [];
    }

    return Object.entries(window.__SSBCONFIG_UPLOADED_FILES__).map(([path, content]) => ({ path, content }));
  };

  const customWidgets = useMemo(() => ({
    file: FileWidget,
    FileWidget
  }), []);

  async function fetchBootstrap() {
    setLoading(true);
    setStatus({ type: 'info', message: 'Loading config from GitHub...' });
    try {
      const response = await fetch(buildPluginUrl('?pin=ssbconfig&api=bootstrap&user=1'));
      const payload = await parseApiResponse(response);
      if (!response.ok) throw new Error(payload.error || 'Bootstrap failed');

      const nextData = payload.configData || {};

      setSchema(payload.schema || { type: 'object', properties: {} });
      setUiSchema(payload.uiSchema || null);
      setData(nextData);
      setDomainId(typeof payload.domainId === 'string' ? payload.domainId : injectedDomainId);
      setSelectedFiles([]);
      setPreviewContent('');
      setPreviewErrors([]);
      setConfigFileSha(typeof payload.configFileSha === 'string' ? payload.configFileSha : '');
      window.__SSBCONFIG_UPLOADED_FILES__ = {}; // Reset uploaded files on reload

      if (payload.configRepo) {
        setRepoInfo(`${payload.configRepo.owner}/${payload.configRepo.repo} @ ${payload.configRepo.branch} :: ${payload.configRepo.filePath}`);
        window.__SSBCONFIG_REPO_CONTEXT__ = {
          owner: payload.configRepo.owner,
          repo: payload.configRepo.repo,
          branch: payload.configRepo.branch
        };
      } else {
        setRepoInfo('');
        window.__SSBCONFIG_REPO_CONTEXT__ = null;
      }

      const activeDomain = typeof payload.domainId === 'string' && payload.domainId.length > 0 ? payload.domainId : injectedDomainId;
      if (activeDomain.length > 0) {
        setStatus({ type: 'success', message: `Loaded config for domain ${activeDomain}.` });
      } else {
        setStatus({ type: 'success', message: 'Loaded config for default domain.' });
      }
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Bootstrap failed' });
    } finally {
      setLoading(false);
    }
  }

  async function persistChanges(nextData) {
    if (!schema || !nextData || typeof nextData !== 'object') {
      setStatus({ type: 'error', message: 'No config data to save.' });
      return;
    }

    setSaving(true);
    setStatus({ type: 'info', message: 'Committing changes to GitHub...' });

    try {
      const normalizedData = normalizeSchemaDrivenFileData(nextData, schema, domainId);
      const uploadedFiles = getUploadedFiles();
      
      const response = await fetch(buildPluginUrl('?pin=ssbconfig&api=save&user=1'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configData: normalizedData,
          files: uploadedFiles,
          commitMessage,
          configFileSha
        })
      });

      const payload = await parseApiResponse(response);
      if (response.status === 409 && payload.conflict) {
        await fetchBootstrap();
        setStatus({ type: 'warning', message: payload.error || 'Conflict: reloaded latest config from GitHub.' });
        return;
      }
      if (!response.ok) throw new Error(payload.error || 'Save failed');

      setData(normalizedData);
      setStatus({
        type: 'success',
        message: `Committed ${payload.changedFiles ? payload.changedFiles.length : 0} file(s) for domain ${payload.domainId || domainId || injectedDomainId} on ${payload.branch}. Commit: ${payload.commitSha}`,
        rawConfigContent: payload.rawConfigContent || ''
      });
      setSelectedFiles([]);
      window.__SSBCONFIG_UPLOADED_FILES__ = {}; // Clear after successful commit
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Save failed' });
    } finally {
      setSaving(false);
    }
  }

  async function previewChanges(nextData) {
    if (!schema || !nextData || typeof nextData !== 'object') {
      setStatus({ type: 'error', message: 'No config data to preview.' });
      return;
    }

    setPreviewing(true);
    setStatus({ type: 'info', message: 'Generating backend preview and validating full config.yml...' });

    try {
      const normalizedData = normalizeSchemaDrivenFileData(nextData, schema, domainId);
      const uploadedFiles = getUploadedFiles();
      
      const response = await fetch(buildPluginUrl('?pin=ssbconfig&api=preview&user=1'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configData: normalizedData,
          files: uploadedFiles,
          commitMessage,
          configFileSha
        })
      });

      const payload = await parseApiResponse(response);
      if (response.status === 409 && payload.conflict) {
        await fetchBootstrap();
        setStatus({ type: 'warning', message: payload.error || 'Conflict: reloaded latest config from GitHub.' });
        return;
      }
      if (!response.ok) throw new Error(payload.error || 'Preview failed');

      const errors = Array.isArray(payload.validationErrors) ? payload.validationErrors : [];
      setData(normalizedData);
      setPreviewContent(payload.rawConfigContent || '');
      setPreviewErrors(errors);

      if (errors.length > 0) {
        setStatus({
          type: 'error',
          message: `Preview generated, but backend validation found ${errors.length} error${errors.length === 1 ? '' : 's'}.`,
          rawConfigContent: payload.rawConfigContent || ''
        });
      } else {
        setStatus({
          type: 'success',
          message: `Preview looks valid for domain ${payload.domainId || domainId || injectedDomainId}. You can now commit to GitHub.`,
          rawConfigContent: payload.rawConfigContent || ''
        });
      }
    } catch (err) {
      setStatus({ type: 'error', message: err.message || 'Preview failed' });
    } finally {
      setPreviewing(false);
    }
  }

  async function onFileSelection(evt) {
    const files = Array.from(evt.target.files || []);
    const converted = [];

    for (const file of files) {
      const buffer = await file.arrayBuffer();
      const relative = normalizePath(file.webkitRelativePath || file.name);
      converted.push({
        path: relative,
        contentBase64: toBase64(buffer)
      });
    }

    setSelectedFiles(converted);
  }

  async function onSave() {
    if (submitButtonRef.current) {
      submitButtonRef.current.click();
      return;
    }

    await previewChanges(data);
  }

  React.useEffect(() => {
    fetchBootstrap();
  }, []);

  return (
    <Box sx={{ p: 2, backgroundColor: '#f4f6fa', minHeight: '100vh' }}>
      <Stack spacing={2}>
        <Card>
          <CardContent>
            <Typography variant="h5">Sikker Selvbetjening Config Editor</Typography>
            <Typography variant="body2" color="text.secondary">
              JSON Forms bundle running locally inside this plugin.
            </Typography>
            {repoInfo ? (
              <Typography variant="caption" sx={{ fontFamily: 'monospace', display: 'block', mt: 1 }}>
                {repoInfo}
              </Typography>
            ) : null}
            <Typography variant="caption" sx={{ fontFamily: 'monospace', display: 'block', mt: 0.5 }}>
              Active MeshCentral domain: {domainId || '(default)'}
            </Typography>
            {configFileSha ? (
              <Typography variant="caption" sx={{ fontFamily: 'monospace', display: 'block', mt: 0.5 }}>
                Loaded commit SHA: {configFileSha}
              </Typography>
            ) : null}
          </CardContent>
        </Card>

        <Alert severity={status.type === 'error' ? 'error' : status.type === 'success' ? 'success' : status.type === 'warning' ? 'warning' : 'info'}>
          <Stack spacing={1}>
            <Typography variant="body2">{status.message}</Typography>
          </Stack>
        </Alert>

        {previewErrors.length > 0 ? (
          <Alert severity="error">
            <Stack spacing={0.5}>
              <Typography variant="body2">Validation errors</Typography>
              {previewErrors.map((err, idx) => (
                <Typography key={`${idx}-${err.path || 'root'}`} variant="caption" sx={{ fontFamily: 'monospace' }}>
                  {(err && err.text) || (err && err.message) || 'Unknown validation error'}
                </Typography>
              ))}
            </Stack>
          </Alert>
        ) : null}

        {previewContent ? (
          <Card
            sx={{
              width: 'calc(100vw - 24px)',
              maxWidth: 'none',
              ml: 'calc(50% - 50vw + 12px)',
              mr: 'calc(50% - 50vw + 12px)'
            }}
          >
            <CardContent>
              <TextField
                label="Raw config.yml preview"
                multiline
                fullWidth
                minRows={10}
                maxRows={28}
                value={previewContent}
                InputProps={{
                  readOnly: true,
                  sx: {
                    fontFamily: 'monospace',
                    fontSize: 12,
                    '& textarea': {
                      whiteSpace: 'pre',
                      overflowX: 'auto',
                      overflowY: 'auto',
                      wordBreak: 'normal'
                    }
                  }
                }}
                inputProps={{ wrap: 'off' }}
              />
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 2 }}>Config Form</Typography>
            {schema ? (
              <Form
                idPrefix="ssbconfig"
                schema={schema}
                {...(uiSchema && typeof uiSchema === 'object' && Object.keys(uiSchema).length > 0 ? { uiSchema } : {})}
                formData={data}
                validator={validator}
                widgets={customWidgets}
                noValidate
                liveValidate={false}
                noHtml5Validate
                showErrorList={false}
                onChange={({ formData: nextData }) => {
                  setData(nextData || {});
                  setPreviewContent('');
                  setPreviewErrors([]);
                }}
                onSubmit={({ formData: nextData }) => {
                  void previewChanges(nextData || {});
                }}
              >
                <button
                  ref={submitButtonRef}
                  type="submit"
                  style={{ display: 'none' }}
                  aria-hidden="true"
                  tabIndex={-1}
                >
                  Submit
                </button>
              </Form>
            ) : (
              <Typography variant="body2">Schema not loaded yet.</Typography>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 2 }}>Assets + Commit</Typography>
            <Stack spacing={2}>
              <Typography variant="caption" sx={{ display: 'block', fontFamily: 'monospace' }}>
                {assetPathInfo}
              </Typography>

              <Box>
                <Typography variant="body2" sx={{ mb: 0.5 }}>Upload files or folder</Typography>
                <input type="file" multiple webkitdirectory="" onChange={onFileSelection} />
                <Typography variant="caption" sx={{ display: 'block', mt: 1 }}>
                  Selected files: {selectedFiles.length}
                </Typography>
              </Box>

              <TextField
                fullWidth
                label="Commit message"
                value={commitMessage}
                onChange={(evt) => setCommitMessage(evt.target.value)}
              />

              <Stack direction="row" spacing={1}>
                <Button variant="contained" disabled={loading || previewing || saving} onClick={onSave}>
                  {previewing ? 'Previewing...' : 'Preview + Validate'}
                </Button>
                <Button
                  variant="contained"
                  color="success"
                  disabled={loading || previewing || saving || !previewContent || previewErrors.length > 0}
                  onClick={() => {
                    void persistChanges(data);
                  }}
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
