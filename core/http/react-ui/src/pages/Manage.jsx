import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useOutletContext, useSearchParams } from 'react-router-dom'
import ResourceMonitor from '../components/ResourceMonitor'
import ConfirmDialog from '../components/ConfirmDialog'
import Toggle from '../components/Toggle'
import NodeDistributionChip from '../components/NodeDistributionChip'
import { useModels } from '../hooks/useModels'
import { backendControlApi, modelsApi, backendsApi, systemApi, nodesApi } from '../utils/api'

const TABS = [
  { key: 'models', label: 'Models', icon: 'fa-brain' },
  { key: 'backends', label: 'Backends', icon: 'fa-server' },
]

// formatInstalledAt renders an installed_at timestamp as a short relative/abs
// string suitable for dense tables. Returns the raw value if parsing fails so
// we never display "Invalid Date".
function formatInstalledAt(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (isNaN(d.getTime())) return value
  const now = Date.now()
  const diffMin = Math.floor((now - d.getTime()) / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffMin < 60 * 24) return `${Math.floor(diffMin / 60)}h ago`
  if (diffMin < 60 * 24 * 30) return `${Math.floor(diffMin / (60 * 24))}d ago`
  return d.toISOString().slice(0, 10)
}

export default function Manage() {
  const { addToast } = useOutletContext()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const initialTab = searchParams.get('tab') || localStorage.getItem('manage-tab') || 'models'
  const [activeTab, setActiveTab] = useState(TABS.some(t => t.key === initialTab) ? initialTab : 'models')
  const { models, loading: modelsLoading, refetch: refetchModels } = useModels()
  const [loadedModelIds, setLoadedModelIds] = useState(new Set())
  const [backends, setBackends] = useState([])
  const [backendsLoading, setBackendsLoading] = useState(true)
  const [reloading, setReloading] = useState(false)
  const [reinstallingBackends, setReinstallingBackends] = useState(new Set())
  const [upgrades, setUpgrades] = useState({})
  const [confirmDialog, setConfirmDialog] = useState(null)
  const [distributedMode, setDistributedMode] = useState(false)
  const [togglingModels, setTogglingModels] = useState(new Set())
  const [pinningModels, setPinningModels] = useState(new Set())

  const handleTabChange = (tab) => {
    setActiveTab(tab)
    localStorage.setItem('manage-tab', tab)
    setSearchParams({ tab })
  }

  const fetchLoadedModels = useCallback(async () => {
    try {
      const info = await systemApi.info()
      const loaded = Array.isArray(info?.loaded_models) ? info.loaded_models : []
      setLoadedModelIds(new Set(loaded.map(m => m.id)))
    } catch {
      setLoadedModelIds(new Set())
    }
  }, [])

  const fetchBackends = useCallback(async () => {
    try {
      setBackendsLoading(true)
      const data = await backendsApi.listInstalled()
      setBackends(Array.isArray(data) ? data : [])
    } catch {
      setBackends([])
    } finally {
      setBackendsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchLoadedModels()
    fetchBackends()
    // Detect distributed mode (nodes API returns 503 when not enabled)
    nodesApi.list().then(() => setDistributedMode(true)).catch(() => {})
  }, [fetchLoadedModels, fetchBackends])

  // Auto-refresh the Models tab every 10s in distributed mode so ghost models
  // (loaded on a worker but absent from this frontend's in-memory cache)
  // clear on their own without the user clicking Update.
  const [lastSyncedAt, setLastSyncedAt] = useState(() => Date.now())
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    if (!distributedMode || activeTab !== 'models') return
    const interval = setInterval(() => {
      refetchModels()
      fetchLoadedModels()
      setLastSyncedAt(Date.now())
    }, 10000)
    return () => clearInterval(interval)
  }, [distributedMode, activeTab, refetchModels, fetchLoadedModels])

  // Drive the "last synced Ns ago" label without over-rendering the table.
  useEffect(() => {
    if (!distributedMode) return
    const interval = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [distributedMode])
  const lastSyncedAgo = (() => {
    const s = Math.max(0, Math.floor((nowTick - lastSyncedAt) / 1000))
    if (s < 5) return 'just now'
    if (s < 60) return `${s}s ago`
    const m = Math.floor(s / 60)
    return `${m}m ago`
  })()

  // Fetch available backend upgrades
  useEffect(() => {
    if (activeTab === 'backends') {
      backendsApi.checkUpgrades()
        .then(data => setUpgrades(data || {}))
        .catch(() => {})
    }
  }, [activeTab])

  const handleStopModel = (modelName) => {
    setConfirmDialog({
      title: 'Stop Model',
      message: `Stop model ${modelName}?`,
      confirmLabel: 'Stop',
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null)
        try {
          await backendControlApi.shutdown({ model: modelName })
          addToast(`Stopped ${modelName}`, 'success')
          setTimeout(fetchLoadedModels, 500)
        } catch (err) {
          addToast(`Failed to stop: ${err.message}`, 'error')
        }
      },
    })
  }

  const handleDeleteModel = (modelName) => {
    setConfirmDialog({
      title: 'Delete Model',
      message: `Delete model ${modelName}? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null)
        try {
          await modelsApi.deleteByName(modelName)
          addToast(`Deleted ${modelName}`, 'success')
          refetchModels()
          fetchLoadedModels()
        } catch (err) {
          addToast(`Failed to delete: ${err.message}`, 'error')
        }
      },
    })
  }

  const handleToggleModel = async (modelId, currentlyDisabled) => {
    const action = currentlyDisabled ? 'enable' : 'disable'
    setTogglingModels(prev => new Set(prev).add(modelId))
    try {
      await modelsApi.toggleState(modelId, action)
      addToast(`Model ${modelId} ${action}d`, 'success')
      refetchModels()
      if (!currentlyDisabled) {
        // Model was just disabled, refresh loaded models since it may have been shut down
        setTimeout(fetchLoadedModels, 500)
      }
    } catch (err) {
      addToast(`Failed to ${action} model: ${err.message}`, 'error')
    } finally {
      setTogglingModels(prev => {
        const next = new Set(prev)
        next.delete(modelId)
        return next
      })
    }
  }

  const handleTogglePinned = async (modelId, currentlyPinned) => {
    const action = currentlyPinned ? 'unpin' : 'pin'
    setPinningModels(prev => new Set(prev).add(modelId))
    try {
      await modelsApi.togglePinned(modelId, action)
      addToast(`Model ${modelId} ${action}ned`, 'success')
      refetchModels()
    } catch (err) {
      addToast(`Failed to ${action} model: ${err.message}`, 'error')
    } finally {
      setPinningModels(prev => {
        const next = new Set(prev)
        next.delete(modelId)
        return next
      })
    }
  }

  const handleReload = async () => {
    setReloading(true)
    try {
      await modelsApi.reload()
      addToast('Models reloaded', 'success')
      setTimeout(() => { refetchModels(); fetchLoadedModels(); setReloading(false) }, 1000)
    } catch (err) {
      addToast(`Reload failed: ${err.message}`, 'error')
      setReloading(false)
    }
  }

  const handleReinstallBackend = async (name) => {
    try {
      setReinstallingBackends(prev => new Set(prev).add(name))
      await backendsApi.install(name)
      addToast(`Reinstalling ${name}...`, 'info')
    } catch (err) {
      addToast(`Failed to reinstall: ${err.message}`, 'error')
    } finally {
      setReinstallingBackends(prev => {
        const next = new Set(prev)
        next.delete(name)
        return next
      })
    }
  }

  const handleUpgradeBackend = async (name) => {
    try {
      setReinstallingBackends(prev => new Set(prev).add(name))
      await backendsApi.upgrade(name)
      addToast(`Upgrading ${name}...`, 'info')
    } catch (err) {
      addToast(`Failed to upgrade: ${err.message}`, 'error')
    } finally {
      setReinstallingBackends(prev => {
        const next = new Set(prev)
        next.delete(name)
        return next
      })
    }
  }

  const [upgradingAll, setUpgradingAll] = useState(false)
  const [showOnlyUpgradable, setShowOnlyUpgradable] = useState(false)
  const handleUpgradeAll = async () => {
    const names = Object.keys(upgrades)
    if (names.length === 0) return
    setUpgradingAll(true)
    try {
      // Serial upgrade — matches the gallery's Upgrade All behavior.
      // Each backend upgrade is itself a cluster-wide fan-out, so parallel
      // calls would multiply load on every worker.
      for (const name of names) {
        try {
          await backendsApi.upgrade(name)
        } catch (err) {
          addToast(`Upgrade failed for ${name}: ${err.message}`, 'error')
        }
      }
      addToast(`Upgrade started for ${names.length} backend${names.length === 1 ? '' : 's'}`, 'info')
    } finally {
      setUpgradingAll(false)
    }
  }

  const handleDeleteBackend = (name) => {
    setConfirmDialog({
      title: 'Delete Backend',
      message: `Delete backend ${name}?`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null)
        try {
          await backendsApi.deleteInstalled(name)
          addToast(`Deleted backend ${name}`, 'success')
          fetchBackends()
        } catch (err) {
          addToast(`Failed to delete backend: ${err.message}`, 'error')
        }
      },
    })
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">System</h1>
        <p className="page-subtitle">Manage installed models and backends</p>
      </div>

      {/* Resource Monitor */}
      <ResourceMonitor />

      {/* Tabs */}
      <div className="tabs" style={{ marginTop: 'var(--spacing-lg)', marginBottom: 'var(--spacing-md)' }}>
        {TABS.map(t => {
          const upgradeCount = t.key === 'backends' ? Object.keys(upgrades).length : 0
          return (
            <button
              key={t.key}
              className={`tab ${activeTab === t.key ? 'tab-active' : ''}`}
              onClick={() => handleTabChange(t.key)}
            >
              <i className={`fas ${t.icon}`} style={{ marginRight: 6 }} />
              {t.label}
              {t.key === 'models' && !modelsLoading && ` (${models.length})`}
              {t.key === 'backends' && !backendsLoading && ` (${backends.length})`}
              {upgradeCount > 0 && (
                <span className="tab-pill tab-pill--warning" title={`${upgradeCount} update${upgradeCount === 1 ? '' : 's'} available`}>
                  <i className="fas fa-arrow-up" /> {upgradeCount}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Models Tab */}
      {activeTab === 'models' && (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-md)' }}>
          {distributedMode && (
            <span className="cell-muted" title="Auto-refreshes every 10s in distributed mode so ghost models clear promptly">
              <i className="fas fa-rotate" /> Last synced {lastSyncedAgo}
            </span>
          )}
          <button className="btn btn-secondary btn-sm" onClick={handleReload} disabled={reloading}>
            <i className={`fas ${reloading ? 'fa-spinner fa-spin' : 'fa-rotate'}`} />
            {reloading ? 'Updating...' : 'Update'}
          </button>
        </div>

        {modelsLoading ? (
          <div className="card" style={{ padding: 'var(--spacing-xl)', textAlign: 'center', color: 'var(--color-text-muted)' }}>
            <i className="fas fa-circle-notch fa-spin" /> Loading models...
          </div>
        ) : models.length === 0 ? (
          <div className="card" style={{ padding: 'var(--spacing-xl)', textAlign: 'center' }}>
            <i className="fas fa-exclamation-triangle" style={{ fontSize: '2rem', color: 'var(--color-warning)', marginBottom: 'var(--spacing-md)' }} />
            <h3 style={{ marginBottom: 'var(--spacing-sm)' }}>No models installed yet</h3>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem', marginBottom: 'var(--spacing-md)' }}>
              Install a model from the gallery to get started.
            </p>
            <div style={{ display: 'flex', gap: 'var(--spacing-sm)', justifyContent: 'center' }}>
              <button className="btn btn-primary btn-sm" onClick={() => navigate('/app/models')}>
                <i className="fas fa-store" /> Browse Gallery
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => navigate('/app/import-model')}>
                <i className="fas fa-upload" /> Import Model
              </button>
              <a className="btn btn-secondary btn-sm" href="https://localai.io" target="_blank" rel="noopener noreferrer">
                <i className="fas fa-book" /> Documentation
              </a>
            </div>
          </div>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>Enabled</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Backend</th>
                  <th>Use Cases</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {models.map(model => (
                  <tr key={model.id} style={{ opacity: model.disabled ? 0.55 : 1, transition: 'opacity 0.2s' }}>
                    {/* Enable/Disable toggle */}
                    <td>
                      <Toggle
                        checked={!model.disabled}
                        onChange={() => handleToggleModel(model.id, model.disabled)}
                        disabled={togglingModels.has(model.id)}
                      />
                    </td>
                    {/* Name */}
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)' }}>
                        <span style={{ fontWeight: 500 }}>{model.id}</span>
                        {model.pinned && (
                          <i className="fas fa-thumbtack" style={{ fontSize: '0.625rem', color: 'var(--color-warning)' }} title="Pinned — won't be idle-unloaded" />
                        )}
                        <div style={{ display: 'flex', gap: '2px', marginLeft: 'auto' }}>
                          <a
                            href="#"
                            onClick={(e) => { e.preventDefault(); navigate(`/app/model-editor/${encodeURIComponent(model.id)}`) }}
                            className="btn btn-secondary btn-sm"
                            style={{ padding: '2px 5px', fontSize: '0.625rem' }}
                            title="Edit config"
                          >
                            <i className="fas fa-pen-to-square" />
                          </a>
                          {!distributedMode && (
                            <a
                              href="#"
                              onClick={(e) => { e.preventDefault(); navigate(`/app/backend-logs/${encodeURIComponent(model.id)}`) }}
                              className="btn btn-secondary btn-sm"
                              style={{ padding: '2px 5px', fontSize: '0.625rem' }}
                              title="Backend logs"
                            >
                              <i className="fas fa-terminal" />
                            </a>
                          )}
                        </div>
                      </div>
                    </td>
                    {/* Status / Distribution */}
                    <td>
                      <div className="cell-stack">
                        {model.disabled ? (
                          <span className="badge" style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-muted)' }}>
                            <i className="fas fa-ban" /> Disabled
                          </span>
                        ) : model.loaded_on && model.loaded_on.length > 0 ? (
                          // Distributed mode: surface where the model is
                          // actually loaded. Shared chip scales to any cluster
                          // size (inline for <=3, popover for larger).
                          <NodeDistributionChip nodes={model.loaded_on} context="models" />
                        ) : loadedModelIds.has(model.id) ? (
                          <span className="badge badge-success">
                            <i className="fas fa-circle" style={{ fontSize: '6px' }} /> Running
                          </span>
                        ) : (
                          <span className="badge" style={{ background: 'var(--color-bg-tertiary)', color: 'var(--color-text-muted)' }}>
                            <i className="fas fa-circle" style={{ fontSize: '6px' }} /> Idle
                          </span>
                        )}
                        {model.source === 'registry-only' && (
                          <span className="badge badge-warning" title="Discovered on a worker but not configured locally. Persist the config to make it permanent.">
                            <i className="fas fa-ghost" /> Adopted
                          </span>
                        )}
                      </div>
                    </td>
                    {/* Backend */}
                    <td>
                      <span className="badge badge-info">{model.backend || 'Auto'}</span>
                    </td>
                    {/* Use Cases */}
                    <td>
                      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                        <a href="#" onClick={(e) => { e.preventDefault(); navigate(`/app/chat/${encodeURIComponent(model.id)}`) }} className="badge badge-info" style={{ textDecoration: 'none', cursor: 'pointer' }}>Chat</a>
                      </div>
                    </td>
                    {/* Actions */}
                    <td>
                      <div style={{ display: 'flex', gap: 'var(--spacing-xs)', justifyContent: 'flex-end', alignItems: 'center' }}>
                        {loadedModelIds.has(model.id) && (
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleStopModel(model.id)}
                            title="Stop model"
                          >
                            <i className="fas fa-stop" />
                          </button>
                        )}
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleTogglePinned(model.id, model.pinned)}
                          disabled={pinningModels.has(model.id) || model.disabled}
                          title={model.pinned ? 'Unpin model (allow idle unloading)' : 'Pin model (prevent idle unloading)'}
                          style={{
                            color: model.pinned ? 'var(--color-warning)' : undefined,
                          }}
                        >
                          <i className={`fas fa-thumbtack${pinningModels.has(model.id) ? ' fa-spin' : ''}`} />
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => handleDeleteModel(model.id)}
                          title="Delete model"
                        >
                          <i className="fas fa-trash" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}

      {/* Backends Tab */}
      {activeTab === 'backends' && (
      <div>
        {/* Upgrade banner — mirrors the gallery so operators can't miss updates */}
        {!backendsLoading && Object.keys(upgrades).length > 0 && (
          <div className="upgrade-banner">
            <div className="upgrade-banner__text">
              <i className="fas fa-arrow-up" />
              <span>
                {Object.keys(upgrades).length} backend{Object.keys(upgrades).length === 1 ? ' has' : 's have'} updates available
              </span>
            </div>
            <div className="upgrade-banner__actions">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setShowOnlyUpgradable(v => !v)}
                title={showOnlyUpgradable ? 'Show all backends' : 'Show only backends with updates'}
              >
                <i className={`fas ${showOnlyUpgradable ? 'fa-filter-circle-xmark' : 'fa-filter'}`} />
                {showOnlyUpgradable ? ' Show all' : ' Updates only'}
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleUpgradeAll}
                disabled={upgradingAll}
              >
                <i className={`fas ${upgradingAll ? 'fa-spinner fa-spin' : 'fa-arrow-up'}`} />
                {upgradingAll ? ' Upgrading...' : ' Upgrade all'}
              </button>
            </div>
          </div>
        )}

        {backendsLoading ? (
          <div style={{ textAlign: 'center', padding: 'var(--spacing-md)', color: 'var(--color-text-muted)', fontSize: '0.875rem' }}>
            Loading backends...
          </div>
        ) : backends.length === 0 ? (
          <div className="card" style={{ padding: 'var(--spacing-xl)', textAlign: 'center' }}>
            <i className="fas fa-server" style={{ fontSize: '2rem', color: 'var(--color-text-muted)', marginBottom: 'var(--spacing-md)' }} />
            <h3 style={{ marginBottom: 'var(--spacing-sm)' }}>No backends installed yet</h3>
            <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem', marginBottom: 'var(--spacing-md)' }}>
              Install backends from the gallery to extend functionality.
            </p>
            <div style={{ display: 'flex', gap: 'var(--spacing-sm)', justifyContent: 'center' }}>
              <button className="btn btn-primary btn-sm" onClick={() => navigate('/app/backends')}>
                <i className="fas fa-server" /> Browse Backend Gallery
              </button>
              <a className="btn btn-secondary btn-sm" href="https://localai.io/backends/" target="_blank" rel="noopener noreferrer">
                <i className="fas fa-book" /> Documentation
              </a>
            </div>
          </div>
        ) : (() => {
          const visibleBackends = showOnlyUpgradable
            ? backends.filter(b => upgrades[b.Name])
            : backends
          if (visibleBackends.length === 0) {
            return (
              <div className="empty-state">
                <i className="fas fa-filter" />
                <p>No backends match the current filter.</p>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowOnlyUpgradable(false)}>Clear filter</button>
              </div>
            )
          }
          return (
          <div className="table-container">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Version</th>
                  {distributedMode && <th>Nodes</th>}
                  <th>Installed</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleBackends.map((backend, i) => {
                  const upgradeInfo = upgrades[backend.Name]
                  const hasDrift = upgradeInfo?.node_drift?.length > 0
                  const nodes = backend.Nodes || backend.nodes || []
                  return (
                  <tr key={backend.Name || i}>
                    <td>
                      <div className="cell-name">
                        <i className="fas fa-cog" />
                        <span>{backend.Name}</span>
                        {backend.Metadata?.alias && (
                          <span className="cell-subtle">alias: {backend.Metadata.alias}</span>
                        )}
                        {backend.Metadata?.meta_backend_for && (
                          <span className="cell-subtle">for: {backend.Metadata.meta_backend_for}</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="badge-row">
                        {backend.IsSystem ? (
                          <span className="badge badge-info">
                            <i className="fas fa-shield-alt" /> System
                          </span>
                        ) : (
                          <span className="badge badge-success">
                            <i className="fas fa-download" /> User
                          </span>
                        )}
                        {backend.IsMeta && (
                          <span className="badge badge-accent">
                            <i className="fas fa-layer-group" /> Meta
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="cell-stack">
                        {backend.Metadata?.version ? (
                          <span className="cell-mono">v{backend.Metadata.version}</span>
                        ) : (
                          <span className="cell-muted">—</span>
                        )}
                        {upgradeInfo && (
                          <span className="badge badge-warning" title={upgradeInfo.available_version ? `Upgrade to v${upgradeInfo.available_version}` : 'Update available'}>
                            <i className="fas fa-arrow-up" />
                            {upgradeInfo.available_version ? ` v${upgradeInfo.available_version}` : ' Update available'}
                          </span>
                        )}
                        {hasDrift && (
                          <span
                            className="badge badge-warning"
                            title={`Drift: ${upgradeInfo.node_drift.map(d => `${d.node_name}${d.version ? ' v' + d.version : ''}`).join(', ')}`}
                          >
                            <i className="fas fa-code-branch" />
                            {' '}Drift: {upgradeInfo.node_drift.length} node{upgradeInfo.node_drift.length === 1 ? '' : 's'}
                          </span>
                        )}
                      </div>
                    </td>
                    {distributedMode && (
                      <td>
                        <NodeDistributionChip nodes={nodes} context="backends" />
                      </td>
                    )}
                    <td>
                      <span className="cell-muted cell-mono">
                        {backend.Metadata?.installed_at ? formatInstalledAt(backend.Metadata.installed_at) : '—'}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        {backend.IsSystem ? (
                          <span className="badge" title="System backends are managed outside the gallery">
                            <i className="fas fa-lock" /> Protected
                          </span>
                        ) : (
                          <>
                            {upgradeInfo ? (
                              <button
                                className="btn btn-primary btn-sm"
                                onClick={() => handleUpgradeBackend(backend.Name)}
                                disabled={reinstallingBackends.has(backend.Name)}
                              >
                                <i className={`fas ${reinstallingBackends.has(backend.Name) ? 'fa-spinner fa-spin' : 'fa-arrow-up'}`} />
                                {' '}Upgrade{upgradeInfo.available_version ? ` to v${upgradeInfo.available_version}` : ''}
                              </button>
                            ) : (
                              <button
                                className="btn btn-secondary btn-sm"
                                onClick={() => handleReinstallBackend(backend.Name)}
                                disabled={reinstallingBackends.has(backend.Name)}
                              >
                                <i className={`fas ${reinstallingBackends.has(backend.Name) ? 'fa-spinner fa-spin' : 'fa-rotate'}`} />
                                {' '}Reinstall
                              </button>
                            )}
                            <button
                              className="btn btn-danger-ghost btn-sm"
                              onClick={() => handleDeleteBackend(backend.Name)}
                              title="Delete backend (removes from all nodes)"
                            >
                              <i className="fas fa-trash" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          )
        })()}
      </div>
      )}

      <ConfirmDialog
        open={!!confirmDialog}
        title={confirmDialog?.title}
        message={confirmDialog?.message}
        confirmLabel={confirmDialog?.confirmLabel}
        danger={confirmDialog?.danger}
        onConfirm={confirmDialog?.onConfirm}
        onCancel={() => setConfirmDialog(null)}
      />
    </div>
  )
}
