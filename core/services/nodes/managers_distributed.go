package nodes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/mudler/LocalAI/core/config"
	"github.com/mudler/LocalAI/core/gallery"
	"github.com/mudler/LocalAI/core/services/galleryop"
	"github.com/mudler/LocalAI/pkg/model"
	"github.com/mudler/LocalAI/pkg/system"
	"github.com/mudler/xlog"
	"github.com/nats-io/nats.go"
)

// DistributedModelManager wraps a local ModelManager and adds NATS fan-out
// for model deletion so worker nodes clean up stale files.
type DistributedModelManager struct {
	local   galleryop.ModelManager
	adapter *RemoteUnloaderAdapter
}

// NewDistributedModelManager creates a DistributedModelManager.
// Backend auto-install is disabled because the frontend node delegates
// inference to workers and never runs backends locally.
func NewDistributedModelManager(appConfig *config.ApplicationConfig, ml *model.ModelLoader, adapter *RemoteUnloaderAdapter) *DistributedModelManager {
	local := galleryop.NewLocalModelManager(appConfig, ml)
	local.SetAutoInstallBackend(false)
	return &DistributedModelManager{
		local:   local,
		adapter: adapter,
	}
}

func (d *DistributedModelManager) DeleteModel(name string) error {
	err := d.local.DeleteModel(name)
	// Best-effort: fan out model.delete to worker nodes
	if rcErr := d.adapter.DeleteModelFiles(name); rcErr != nil {
		xlog.Warn("Failed to propagate model file deletion to workers", "model", name, "error", rcErr)
	}
	return err
}

func (d *DistributedModelManager) InstallModel(ctx context.Context, op *galleryop.ManagementOp[gallery.GalleryModel, gallery.ModelConfig], progressCb galleryop.ProgressCallback) error {
	return d.local.InstallModel(ctx, op, progressCb)
}

// DistributedBackendManager wraps a local BackendManager and adds NATS fan-out
// for backend deletion so worker nodes clean up stale files.
type DistributedBackendManager struct {
	local            galleryop.BackendManager
	adapter          *RemoteUnloaderAdapter
	registry         *NodeRegistry
	backendGalleries []config.Gallery
	systemState      *system.SystemState
}

// NewDistributedBackendManager creates a DistributedBackendManager.
func NewDistributedBackendManager(appConfig *config.ApplicationConfig, ml *model.ModelLoader, adapter *RemoteUnloaderAdapter, registry *NodeRegistry) *DistributedBackendManager {
	return &DistributedBackendManager{
		local:            galleryop.NewLocalBackendManager(appConfig, ml),
		adapter:          adapter,
		registry:         registry,
		backendGalleries: appConfig.BackendGalleries,
		systemState:      appConfig.SystemState,
	}
}

func (d *DistributedBackendManager) DeleteBackend(name string) error {
	// Try local deletion but ignore "not found" errors — in distributed mode
	// the frontend node typically doesn't have backends installed locally;
	// they only exist on worker nodes.
	if err := d.local.DeleteBackend(name); err != nil {
		if !errors.Is(err, gallery.ErrBackendNotFound) {
			return err
		}
		xlog.Debug("Backend not found locally, will attempt deletion on workers", "backend", name)
	}
	// Fan out backend.delete to all healthy nodes
	allNodes, listErr := d.registry.List(context.Background())
	if listErr != nil {
		xlog.Warn("Failed to list nodes for backend deletion fan-out", "error", listErr)
		return listErr
	}
	var errs []error
	for _, node := range allNodes {
		if node.Status != StatusHealthy {
			continue
		}
		if _, delErr := d.adapter.DeleteBackend(node.ID, name); delErr != nil {
			if errors.Is(delErr, nats.ErrNoResponders) {
				// Node's NATS subscription is gone — likely restarted with a new ID.
				// Mark it unhealthy so future fan-outs skip it.
				xlog.Warn("No NATS responders for node, marking unhealthy", "node", node.Name, "nodeID", node.ID)
				d.registry.MarkUnhealthy(context.Background(), node.ID)
				continue
			}
			xlog.Warn("Failed to propagate backend deletion to worker", "node", node.Name, "backend", name, "error", delErr)
			errs = append(errs, fmt.Errorf("node %s: %w", node.Name, delErr))
		}
	}
	return errors.Join(errs...)
}

// ListBackends aggregates installed backends from all worker nodes, preserving
// per-node attribution. Each SystemBackend.Nodes entry records which node has
// the backend and the version/digest it reports. The top-level Metadata is
// populated from the first node seen so single-node-minded callers still work.
//
// Pending/offline/draining nodes are skipped because they aren't expected to
// answer NATS requests; unhealthy nodes are still queried — ErrNoResponders
// then marks them unhealthy and the loop continues.
func (d *DistributedBackendManager) ListBackends() (gallery.SystemBackends, error) {
	result := make(gallery.SystemBackends)
	allNodes, err := d.registry.List(context.Background())
	if err != nil {
		return result, err
	}

	for _, node := range allNodes {
		if node.Status == StatusPending || node.Status == StatusOffline || node.Status == StatusDraining {
			continue
		}
		reply, err := d.adapter.ListBackends(node.ID)
		if err != nil {
			if errors.Is(err, nats.ErrNoResponders) {
				xlog.Warn("No NATS responders for node, marking unhealthy", "node", node.Name, "nodeID", node.ID)
				d.registry.MarkUnhealthy(context.Background(), node.ID)
				continue
			}
			xlog.Warn("Failed to list backends on worker", "node", node.Name, "error", err)
			continue
		}
		if reply.Error != "" {
			xlog.Warn("Worker returned error listing backends", "node", node.Name, "error", reply.Error)
			continue
		}
		for _, b := range reply.Backends {
			ref := gallery.NodeBackendRef{
				NodeID:      node.ID,
				NodeName:    node.Name,
				NodeStatus:  node.Status,
				Version:     b.Version,
				Digest:      b.Digest,
				URI:         b.URI,
				InstalledAt: b.InstalledAt,
			}
			entry, exists := result[b.Name]
			if !exists {
				entry = gallery.SystemBackend{
					Name:     b.Name,
					IsSystem: b.IsSystem,
					IsMeta:   b.IsMeta,
					Metadata: &gallery.BackendMetadata{
						Name:        b.Name,
						InstalledAt: b.InstalledAt,
						GalleryURL:  b.GalleryURL,
						Version:     b.Version,
						URI:         b.URI,
						Digest:      b.Digest,
					},
				}
			}
			entry.Nodes = append(entry.Nodes, ref)
			result[b.Name] = entry
		}
	}
	return result, nil
}

// InstallBackend fans out backend installation to all healthy worker nodes.
func (d *DistributedBackendManager) InstallBackend(ctx context.Context, op *galleryop.ManagementOp[gallery.GalleryBackend, any], progressCb galleryop.ProgressCallback) error {
	allNodes, err := d.registry.List(context.Background())
	if err != nil {
		return err
	}

	galleriesJSON, _ := json.Marshal(op.Galleries)
	backendName := op.GalleryElementName

	for _, node := range allNodes {
		if node.Status != StatusHealthy {
			continue
		}
		reply, err := d.adapter.InstallBackend(node.ID, backendName, "", string(galleriesJSON))
		if err != nil {
			if errors.Is(err, nats.ErrNoResponders) {
				xlog.Warn("No NATS responders for node, marking unhealthy", "node", node.Name, "nodeID", node.ID)
				d.registry.MarkUnhealthy(context.Background(), node.ID)
				continue
			}
			xlog.Warn("Failed to install backend on worker", "node", node.Name, "backend", backendName, "error", err)
			continue
		}
		if !reply.Success {
			xlog.Warn("Backend install failed on worker", "node", node.Name, "backend", backendName, "error", reply.Error)
		}
	}
	return nil
}

// UpgradeBackend fans out a backend upgrade to all healthy worker nodes.
// TODO: Add dedicated NATS subject for upgrade (currently reuses install with force flag)
func (d *DistributedBackendManager) UpgradeBackend(ctx context.Context, name string, progressCb galleryop.ProgressCallback) error {
	allNodes, err := d.registry.List(context.Background())
	if err != nil {
		return err
	}

	galleriesJSON, _ := json.Marshal(d.backendGalleries)
	var errs []error

	for _, node := range allNodes {
		if node.Status != StatusHealthy {
			continue
		}
		// Reuse install endpoint which will re-download the backend (force mode)
		reply, err := d.adapter.InstallBackend(node.ID, name, "", string(galleriesJSON))
		if err != nil {
			if errors.Is(err, nats.ErrNoResponders) {
				xlog.Warn("No NATS responders for node during upgrade, marking unhealthy", "node", node.Name, "nodeID", node.ID)
				d.registry.MarkUnhealthy(context.Background(), node.ID)
				continue
			}
			errs = append(errs, fmt.Errorf("node %s: %w", node.Name, err))
			continue
		}
		if !reply.Success {
			errs = append(errs, fmt.Errorf("node %s: %s", node.Name, reply.Error))
		}
	}

	return errors.Join(errs...)
}

// CheckUpgrades checks for available backend upgrades across the cluster.
//
// The previous implementation delegated to d.local, which called
// ListSystemBackends on the frontend — but in distributed mode the frontend
// has no backends installed locally, so the upgrade loop never ran and the UI
// never surfaced any upgrades. We now feed the cluster-wide aggregation
// (including per-node versions/digests) into gallery.CheckUpgradesAgainst so
// digest-based detection actually works and cluster drift is visible.
func (d *DistributedBackendManager) CheckUpgrades(ctx context.Context) (map[string]gallery.UpgradeInfo, error) {
	installed, err := d.ListBackends()
	if err != nil {
		return nil, err
	}
	// systemState is used by AvailableBackends (gallery paths + meta-backend
	// resolution). The `installed` argument is what the old code got wrong —
	// it used to come from the empty frontend filesystem.
	return gallery.CheckUpgradesAgainst(ctx, d.backendGalleries, d.systemState, installed)
}
