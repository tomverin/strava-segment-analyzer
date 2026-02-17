// Segment Analyzer JavaScript

/**
 * Compute decoupling % for efforts from the same activity (2+ efforts).
 * Decoupling = (EF1 − EF2) / EF1 × 100. For 3+ efforts: avg of consecutive pairs.
 * EF = efficiency = normalized_watts/HR or average_watts/HR.
 */
function computeDecoupling(efforts) {
    const byActivity = {};
    efforts.forEach(e => {
        const aid = e.activity_id;
        if (aid) {
            if (!byActivity[aid]) byActivity[aid] = [];
            byActivity[aid].push(e);
        }
    });
    Object.values(byActivity).forEach(group => {
        if (group.length < 2) return;
        const sorted = [...group].sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''));
        const getEF = (eff) => {
            if (eff.efficiency != null) return eff.efficiency;
            const hr = eff.average_heartrate;
            const wat = eff.normalized_watts ?? eff.average_watts;
            if (hr && hr > 0 && wat != null) return wat / hr;
            return null;
        };
        const withEF = sorted.map(e => ({ e, ef: getEF(e) })).filter(({ ef }) => ef != null && ef > 0);
        if (withEF.length < 2) return;
        const decouplings = [];
        for (let i = 0; i < withEF.length - 1; i++) {
            const efCurr = withEF[i].ef;
            const efNext = withEF[i + 1].ef;
            if (efCurr > 0) decouplings.push((efCurr - efNext) / efCurr * 100);
        }
        if (decouplings.length === 0) return;
        const pct = Math.round(decouplings.reduce((a, b) => a + b, 0) / decouplings.length * 10) / 10;
        group.forEach(e => { e.decoupling_pct = pct; });
    });
}

class SegmentAnalyzer {
    constructor() {
        this.allEfforts = [];
        this.filteredEfforts = [];
        this.currentSort = { field: 'start_date', direction: 'desc' };
        this.fallbackMode = false;
        
        this.init();
    }
    
    setDefaultValues() {
        // Set today's date as end date
        const today = new Date().toISOString().split('T')[0];
        document.getElementById('endDate').value = today;
        
        // Apply default filters and show active state
        this.updateFilterIndicators();
    }
    
    init() {
        this.setDefaultValues();
        this.bindEvents();
        this.loadEfforts();
        this.loadCacheStats();
    }
    
    bindEvents() {
        // Filter controls
        document.getElementById('applyFilters').addEventListener('click', () => this.applyFilters());
        document.getElementById('clearFilters').addEventListener('click', () => this.clearFilters());
        document.getElementById('resetDefaults').addEventListener('click', () => this.resetToDefaults());
        
        // Auto-apply filters on input change (debounced)
        const filterInputs = ['minHeartRate', 'maxHeartRate', 'minPower', 'maxPower', 'startDate', 'endDate', 'bikeFilter'];
        filterInputs.forEach(id => {
            document.getElementById(id).addEventListener('input', 
                debounce(() => this.applyFilters(), 500)
            );
        });
        const bikeFilterSelect = document.getElementById('bikeFilter');
        if (bikeFilterSelect) {
            bikeFilterSelect.addEventListener('change', () => this.applyFilters());
        }
        
        // Sort controls
        document.querySelectorAll('[data-sort]').forEach(header => {
            header.addEventListener('click', () => {
                const field = header.dataset.sort;
                this.sortEfforts(field);
            });
        });
        
        // Cache management
        const clearCacheBtn = document.getElementById('clearCacheBtn');
        if (clearCacheBtn) {
            clearCacheBtn.addEventListener('click', () => this.clearCache());
        }

        const refreshEffortsBtn = document.getElementById('refreshEffortsBtn');
        if (refreshEffortsBtn) {
            refreshEffortsBtn.addEventListener('click', () => this.refreshEfforts());
        }
    }
    
    async loadEfforts(forceRefresh = false) {
        const loadingIndicator = document.getElementById('loadingIndicator');
        const errorPanel = document.getElementById('errorPanel');
        
        // First, try to load from client-side cache for instant display
        const cachedData = forceRefresh ? null : this.getCachedEfforts();
        if (cachedData && cachedData.length > 0) {
            console.log('Loading from cache for instant display');
            this.allEfforts = cachedData;
            computeDecoupling(this.allEfforts);
            this.filteredEfforts = [...this.allEfforts];
            this.updateBikeFilterOptions();
            this.renderEfforts();
            this.updateStatistics();
            this.applyFilters();
            
            // Show cache info banner
            this.showCacheInfoBanner();
            
            // Show refresh indicator instead of loading
            this.showRefreshIndicator();
        } else {
            // No cache or force refresh, show full loading
            loadingIndicator.classList.remove('hidden');
        }
        
        // Then fetch fresh data in the background
        try {
            errorPanel.classList.add('hidden');
            
            const queryParams = [];
            if (this.fallbackMode) {
                queryParams.push('fallback=true');
            }
            if (forceRefresh) {
                queryParams.push('refresh=true');
            }
            const queryString = queryParams.length ? `?${queryParams.join('&')}` : '';
            const response = await axios.get(`/segment/${window.segmentData.id}/efforts${queryString}`);
            const freshData = response.data;
            
            // Update with fresh data (compute decoupling in case backend didn't or cache)
            this.allEfforts = freshData;
            computeDecoupling(this.allEfforts);
            this.filteredEfforts = [...this.allEfforts];
            this.updateBikeFilterOptions();
            
            // Cache the fresh data
            this.setCachedEfforts(freshData);
            
            this.renderEfforts();
            this.updateStatistics();
            this.applyFilters();
            
            if (this.allEfforts.length === 0) {
                this.showNoEffortsMessage();
            }
            
            if (this.fallbackMode) {
                this.showFallbackNotice();
            }
            
            // Show success notification if we updated from cache
            if (cachedData && cachedData.length > 0) {
                showNotification('Data refreshed', 'success');
            }
            
        } catch (error) {
            console.error('Error loading efforts:', error);
            
            // If we have cached data, don't show error, just notify about refresh failure
            if (cachedData && cachedData.length > 0) {
                showNotification('Could not refresh data, showing cached version', 'warning');
            } else {
                // No cached data, show error normally
                            if (error.response?.status === 401 && error.response?.data?.needs_reauth) {
                showNotification('Session expired. Redirecting to login...', 'warning');
                setTimeout(() => window.location.reload(), 2000);
            } else if (error.response?.status === 429) {
                const retryAfter = error.response?.data?.retry_after_seconds;
                const message = retryAfter
                    ? `Rate limit reached. Retry in about ${retryAfter}s.`
                    : 'Rate limit reached. Please retry later.';
                this.showError(message);
                showNotification(message, 'warning');
            } else {
                this.showError(error.response?.data?.error || 'Failed to load segment efforts');
            }
            }
        } finally {
            loadingIndicator.classList.add('hidden');
            this.hideRefreshIndicator();
        }
    }
    
    applyFilters() {
        const minHR = parseFloat(document.getElementById('minHeartRate').value) || null;
        const maxHR = parseFloat(document.getElementById('maxHeartRate').value) || null;
        const minPower = parseFloat(document.getElementById('minPower').value) || null;
        const maxPower = parseFloat(document.getElementById('maxPower').value) || null;
        const startDate = document.getElementById('startDate').value || null;
        const endDate = document.getElementById('endDate').value || null;
        const bikeFilter = document.getElementById('bikeFilter').value || null;
        
        this.filteredEfforts = this.allEfforts.filter(effort => {
            // Heart rate filter
            if (effort.average_heartrate) {
                if (minHR && effort.average_heartrate < minHR) return false;
                if (maxHR && effort.average_heartrate > maxHR) return false;
            } else if (minHR || maxHR) {
                // Exclude efforts without heart rate data if HR filter is active
                return false;
            }
            
            // Power filter
            if (effort.average_watts) {
                if (minPower && effort.average_watts < minPower) return false;
                if (maxPower && effort.average_watts > maxPower) return false;
            } else if (minPower || maxPower) {
                // Exclude efforts without power data if power filter is active
                return false;
            }
            
            // Date filter
            const effortDate = new Date(effort.start_date).toISOString().split('T')[0];
            if (startDate && effortDate < startDate) return false;
            if (endDate && effortDate > endDate) return false;

            // Bike filter
            const effortBike = effort.bike_name || 'Unknown';
            if (bikeFilter && effortBike !== bikeFilter) return false;
            
            return true;
        });
        
        this.sortEfforts(this.currentSort.field, this.currentSort.direction);
        this.renderEfforts();
        this.updateStatistics();
        this.updateFilterIndicators();
    }
    
    clearFilters() {
        document.getElementById('minHeartRate').value = '';
        document.getElementById('maxHeartRate').value = '';
        document.getElementById('minPower').value = '';
        document.getElementById('maxPower').value = '';
        document.getElementById('startDate').value = '';
        document.getElementById('endDate').value = '';
        document.getElementById('bikeFilter').value = '';
        
        this.filteredEfforts = [...this.allEfforts];
        this.renderEfforts();
        this.updateStatistics();
        this.updateFilterIndicators();
    }
    
    resetToDefaults() {
        // Reset to default values
        document.getElementById('minHeartRate').value = '125';
        document.getElementById('maxHeartRate').value = '140';
        document.getElementById('minPower').value = '200';
        document.getElementById('maxPower').value = '350';
        document.getElementById('startDate').value = '2020-01-01';
        const today = new Date().toISOString().split('T')[0];
        document.getElementById('endDate').value = today;
        document.getElementById('bikeFilter').value = '';
        
        this.applyFilters();
    }
    
    sortEfforts(field, direction = null) {
        // Toggle direction if same field
        if (direction === null) {
            if (this.currentSort.field === field) {
                direction = this.currentSort.direction === 'asc' ? 'desc' : 'asc';
            } else {
                direction = 'desc';
            }
        }
        
        this.currentSort = { field, direction };
        
        this.filteredEfforts.sort((a, b) => {
            let aVal = a[field];
            let bVal = b[field];
            
            // Handle different data types
            if (field === 'start_date') {
                aVal = new Date(aVal);
                bVal = new Date(bVal);
            } else if (typeof aVal === 'string') {
                aVal = aVal.toLowerCase();
                bVal = bVal.toLowerCase();
            }
            
            // Handle null values
            if (aVal === null || aVal === undefined) aVal = direction === 'asc' ? Infinity : -Infinity;
            if (bVal === null || bVal === undefined) bVal = direction === 'asc' ? Infinity : -Infinity;
            
            if (direction === 'asc') {
                return aVal > bVal ? 1 : -1;
            } else {
                return aVal < bVal ? 1 : -1;
            }
        });
        
        this.renderEfforts();
        this.updateSortIndicators(field, direction);
    }
    
    renderEfforts() {
        const tableBody = document.getElementById('effortsTableBody');
        const effortsPanel = document.getElementById('effortsPanel');
        const effortsCount = document.getElementById('effortsCount');
        
        if (this.filteredEfforts.length === 0) {
            if (this.allEfforts.length === 0) {
                effortsPanel.classList.add('hidden');
                return;
            }

            effortsPanel.classList.remove('hidden');
            effortsCount.textContent = `(0 shown / ${this.allEfforts.length} total)`;
            tableBody.innerHTML = `
                <tr>
                    <td colspan="9" class="px-6 py-10 text-center text-sm text-gray-500">
                        No efforts match your current filters. Click <strong>Clear Filters</strong> to see all efforts.
                    </td>
                </tr>
            `;
            return;
        }
        
        effortsPanel.classList.remove('hidden');
        effortsCount.textContent = `(${this.filteredEfforts.length} shown / ${this.allEfforts.length} total)`;
        
        tableBody.innerHTML = this.filteredEfforts.map(effort => `
            <tr class="effort-row">
                <td class="text-gray-900" title="${formatDate(effort.start_date)}">${formatDate(effort.start_date)}</td>
                <td class="text-gray-900">
                    <a href="https://www.strava.com/activities/${effort.activity_id}" target="_blank" class="text-orange-600 hover:text-orange-900 truncate block max-w-[3.5rem]" title="${(effort.name || '').replace(/"/g, '&quot;')} (View on Strava)">${effort.name || '—'}</a>
                </td>
                <td class="text-gray-900">${effort.bike_name || '—'}</td>
                <td class="text-gray-900 font-mono">${formatTime(effort.elapsed_time)}</td>
                <td class="text-gray-900">${effort.average_heartrate ? Math.round(effort.average_heartrate) + ' bpm' : '—'}</td>
                <td class="text-gray-900">${effort.efficiency ? effort.efficiency.toFixed(2) : '—'}</td>
                <td class="text-gray-900">${effort.average_watts ? Math.round(effort.average_watts) + ' W' : '—'}</td>
                <td class="text-gray-900">${effort.vam ? effort.vam + ' m/h' : '—'}</td>
                <td class="text-gray-900">${effort.decoupling_pct != null ? effort.decoupling_pct + '%' : '—'}</td>
            </tr>
        `).join('');
    }
    
    updateStatistics() {
        const statsPanel = document.getElementById('statisticsPanel');
        const statsContent = document.getElementById('statsContent');
        
        if (this.filteredEfforts.length === 0) {
            statsPanel.classList.add('hidden');
            return;
        }
        
        statsPanel.classList.remove('hidden');
        
        // Calculate statistics
        const times = this.filteredEfforts.map(e => e.elapsed_time);
        const heartRates = this.filteredEfforts
            .filter(e => e.average_heartrate)
            .map(e => e.average_heartrate);
        const powers = this.filteredEfforts
            .filter(e => e.average_watts)
            .map(e => e.average_watts);
        const vams = this.filteredEfforts
            .filter(e => e.vam)
            .map(e => e.vam);
        
        const stats = {
            totalEfforts: this.filteredEfforts.length,
            bestTime: Math.min(...times),
            avgTime: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
            avgHeartRate: heartRates.length > 0 ? 
                Math.round(heartRates.reduce((a, b) => a + b, 0) / heartRates.length) : null,
            avgPower: powers.length > 0 ? 
                Math.round(powers.reduce((a, b) => a + b, 0) / powers.length) : null,
            avgVAM: vams.length > 0 ? 
                Math.round(vams.reduce((a, b) => a + b, 0) / vams.length) : null
        };
        
        statsContent.innerHTML = `
            <div class="stat-card">
                <div class="stat-value">${stats.totalEfforts}</div>
                <div class="stat-label">Total Efforts</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${formatTime(stats.bestTime)}</div>
                <div class="stat-label">Best Time</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${formatTime(stats.avgTime)}</div>
                <div class="stat-label">Average Time</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.avgHeartRate ? stats.avgHeartRate + ' bpm' : 'N/A'}</div>
                <div class="stat-label">Avg Heart Rate</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.avgPower ? stats.avgPower + ' W' : 'N/A'}</div>
                <div class="stat-label">Avg Power</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.avgVAM ? stats.avgVAM + ' m/h' : 'N/A'}</div>
                <div class="stat-label">Avg VAM</div>
            </div>
        `;
    }
    
    updateSortIndicators(activeField, direction) {
        // Remove all sort classes
        document.querySelectorAll('[data-sort]').forEach(header => {
            header.classList.remove('sort-asc', 'sort-desc');
        });
        
        // Add class to active header
        const activeHeader = document.querySelector(`[data-sort="${activeField}"]`);
        if (activeHeader) {
            activeHeader.classList.add(`sort-${direction}`);
        }
    }
    
    updateFilterIndicators() {
        const filterInputs = ['minHeartRate', 'maxHeartRate', 'minPower', 'maxPower', 'startDate', 'endDate', 'bikeFilter'];
        filterInputs.forEach(id => {
            const input = document.getElementById(id);
            if (input.value) {
                input.classList.add('filter-active');
            } else {
                input.classList.remove('filter-active');
            }
        });
    }
    
    showError(message) {
        const errorPanel = document.getElementById('errorPanel');
        const errorMessage = document.getElementById('errorMessage');
        
        errorMessage.textContent = message;
        errorPanel.classList.remove('hidden');
    }
    
    showNoEffortsMessage() {
        const effortsPanel = document.getElementById('effortsPanel');
        effortsPanel.innerHTML = `
            <div class="p-12 text-center">
                <i class="fas fa-running text-6xl text-gray-300 mb-4"></i>
                <h3 class="text-xl font-medium text-gray-900 mb-2">No Efforts Found</h3>
                <p class="text-gray-500">You haven't completed this segment yet, or it may take a moment for Strava to sync your activities.</p>
            </div>
        `;
        effortsPanel.classList.remove('hidden');
    }

    showFallbackNotice() {
        const fallbackNotice = document.getElementById('fallbackNotice');
        if (fallbackNotice) {
            fallbackNotice.classList.remove('hidden');
        }
    }

    updateBikeFilterOptions() {
        const select = document.getElementById('bikeFilter');
        if (!select) return;

        const current = select.value || '';
        const bikes = Array.from(
            new Set(this.allEfforts.map(e => e.bike_name || 'Unknown'))
        ).sort((a, b) => a.localeCompare(b));

        select.innerHTML = '<option value="">All Bikes</option>' +
            bikes.map(bike => `<option value="${bike}">${bike}</option>`).join('');

        if (current && bikes.includes(current)) {
            select.value = current;
        }
    }
    
    async loadCacheStats() {
        try {
            const response = await axios.get(`/db/stats?segment_id=${window.segmentData.id}`);
            const stats = response.data;
            const scope = stats.segment_scope || null;
            const totalActivities = Number(scope?.activity_count ?? 0);
            const enrichedActivities = Number(scope?.enriched_activity_count ?? 0);
            const missingActivities = Number(
                scope?.missing_activity_count ?? Math.max(0, totalActivities - enrichedActivities)
            );

            document.getElementById('totalFiles').textContent = scope ? scope.effort_count : '-';
            document.getElementById('totalSize').textContent = this.formatBytes(stats.total_size || 0);
            document.getElementById('segmentCount').textContent = scope
                ? `${enrichedActivities}/${totalActivities}`
                : '-';
            document.getElementById('activityCount').textContent =
                scope && scope.sync_state ? (scope.sync_state.full_sync_completed ? 'Yes' : 'No') : 'No';

            const syncText = document.getElementById('syncStatusText');
            if (syncText) {
                if (!scope) {
                    syncText.innerHTML = '<i class="fas fa-info-circle mr-1"></i>No segment-specific stats yet.';
                } else if (!scope.sync_state) {
                    syncText.innerHTML = '<i class="fas fa-info-circle mr-1"></i>Sync has not started for this segment.';
                } else {
                    const nextPage = scope.sync_state.next_page;
                    const updatedAt = scope.sync_state.updated_at ? new Date(scope.sync_state.updated_at).toLocaleString() : 'unknown';
                    syncText.innerHTML = `<i class="fas fa-info-circle mr-1"></i>Missing activity details: ${missingActivities}. Next backfill page: ${nextPage}. Last update: ${updatedAt}.`;
                }
            }
        } catch (error) {
            console.error('Error loading cache stats:', error);
        }
    }
    
    async clearCache() {
        try {
            const firstConfirm = window.confirm(
                'This will delete all local database data (all segments, efforts, and activities). Continue?'
            );
            if (!firstConfirm) {
                return;
            }

            const typed = window.prompt('Type CLEAR to confirm database wipe:');
            if (typed !== 'CLEAR') {
                showNotification('Database clear cancelled', 'info');
                return;
            }

            await axios.post('/db/clear', { confirm_text: 'CLEAR' });
            // Clear browser storage
            localStorage.clear();
            if (window.indexedDB) {
                const request = indexedDB.deleteDatabase('stravaCache');
                request.onsuccess = () => {
                    console.log('IndexedDB cleared');
                };
            }
            showNotification('Database cleared', 'success');
            this.loadCacheStats(); // Refresh stats
            // Reload efforts from API
            await this.loadEfforts(true);
        } catch (error) {
            console.error('Error clearing database:', error);
            showNotification('Error clearing database', 'error');
        }
    }

    async refreshEfforts() {
        try {
            showNotification('Refreshing efforts from Strava...', 'info');
            await this.loadEfforts(true);
            showNotification('Efforts refreshed successfully', 'success');
        } catch (error) {
            console.error('Error refreshing efforts:', error);
            showNotification('Error refreshing efforts', 'error');
        }
    }
    
    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }
    
    getCachedEfforts() {
        try {
            const cacheKey = `efforts_${window.segmentData.id}`;
            const cached = localStorage.getItem(cacheKey);
            if (cached) {
                const data = JSON.parse(cached);
                // Check if cache is still valid (less than 1 hour old)
                const cacheTime = new Date(data.timestamp);
                const now = new Date();
                const ageHours = (now - cacheTime) / (1000 * 60 * 60);
                
                if (ageHours < 24) { // Use cache if less than 24 hours old for instant loading
                    return data.efforts;
                }
            }
        } catch (error) {
            console.warn('Error reading cached efforts:', error);
        }
        return null;
    }
    
    setCachedEfforts(efforts) {
        try {
            const cacheKey = `efforts_${window.segmentData.id}`;
            const cacheData = {
                efforts: efforts,
                timestamp: new Date().toISOString()
            };
            localStorage.setItem(cacheKey, JSON.stringify(cacheData));
            
            // Store individual efforts in IndexedDB for permanent storage
            if (window.indexedDB) {
                const request = indexedDB.open('stravaCache', 1);
                
                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains('efforts')) {
                        db.createObjectStore('efforts', { keyPath: 'id' });
                    }
                };
                
                request.onsuccess = (event) => {
                    const db = event.target.result;
                    const transaction = db.transaction(['efforts'], 'readwrite');
                    const store = transaction.objectStore('efforts');
                    
                    efforts.forEach(effort => {
                        store.put(effort);
                    });
                };
            }
        } catch (error) {
            console.warn('Error caching efforts:', error);
        }
    }
    
    showRefreshIndicator() {
        // Add a subtle refresh indicator
        const existingIndicator = document.getElementById('refreshIndicator');
        if (existingIndicator) return;
        
        const indicator = document.createElement('div');
        indicator.id = 'refreshIndicator';
        indicator.className = 'fixed top-4 right-4 bg-blue-500 text-white px-3 py-2 rounded-lg shadow-lg z-50 text-sm';
        indicator.innerHTML = '<i class="fas fa-sync fa-spin mr-2"></i>Refreshing...';
        document.body.appendChild(indicator);
    }
    
    hideRefreshIndicator() {
        const indicator = document.getElementById('refreshIndicator');
        if (indicator) {
            indicator.remove();
        }
    }
    
    showCacheInfoBanner() {
        const banner = document.getElementById('cacheInfoBanner');
        if (banner) {
            banner.classList.remove('hidden');
            // Auto-hide after 5 seconds
            setTimeout(() => {
                banner.classList.add('hidden');
            }, 5000);
        }
    }
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', () => {
    new SegmentAnalyzer();
}); 
