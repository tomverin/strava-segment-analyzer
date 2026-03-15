// Segment Analyzer JavaScript

// --- Baseline / Readiness (Forme%) - configurable defaults ---
const READINESS_CONFIG = {
    z2HrMin: 128,
    z2HrMax: 138,
    baselineWindowDays: 120,
    baselineTopN: 10,
};

/**
 * EFF (Efficiency Factor) = Pavg(segment) / HRavg in W/bpm.
 * Used for baseline and Forme% calculations.
 */
function getEF(effort) {
    const hr = effort.average_heartrate;
    const p = effort.average_watts;
    if (hr && hr > 0 && p != null) return p / hr;
    return null;
}

function getPowerUsed(effort) {
    return effort.average_watts;
}

/**
 * Is effort "Z2 strict valid" for baseline calculation.
 * Rules: HR in [z2HrMin, z2HrMax], HR and power non-null/non-zero.
 * Optional: lowConfidence if Pw:Hr variance would fail (power ±3%, time ±5%).
 */
function isZ2Strict(effort, config = READINESS_CONFIG) {
    const hr = effort.average_heartrate;
    const power = getPowerUsed(effort);
    if (hr == null || hr <= 0 || power == null || power <= 0) return { valid: false };
    const hrMin = config.z2HrMin ?? 132;
    const hrMax = config.z2HrMax ?? 138;
    if (hr < hrMin || hr > hrMax) return { valid: false };
    return { valid: true };
}

/**
 * Compute median of a sorted array of numbers.
 */
function median(values) {
    if (!values || values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Baseline = median of top N EFF among Z2-strict-valid efforts in the last windowDays.
 */
function computeBaseline(efforts, config = READINESS_CONFIG) {
    const windowDays = config.baselineWindowDays ?? 120;
    const topN = config.baselineTopN ?? 10;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - windowDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const valid = efforts.filter(e => {
        const sd = (e.start_date || '').slice(0, 10);
        if (sd < cutoffStr) return false;
        const { valid: ok } = isZ2Strict(e, config);
        if (!ok) return false;
        const ef = getEF(e);
        return ef != null && ef > 0;
    });
    if (valid.length === 0) return { baseline: null, count: 0, efforts: [] };
    const withEF = valid.map(e => ({ e, ef: getEF(e) })).sort((a, b) => b.ef - a.ef);
    const top = withEF.slice(0, topN).map(x => x.ef);
    const baseline = median(top);
    return { baseline, count: top.length, efforts: withEF.slice(0, topN) };
}

/**
 * Forme% = (EFF_today / baseline - 1) * 100
 * ΔEFF = EFF_today - baseline
 */
function computeReadiness(effortEF, baseline) {
    if (baseline == null || baseline <= 0 || effortEF == null || effortEF <= 0) return null;
    const formePct = Math.round((effortEF / baseline - 1) * 1000) / 10;
    const deltaEF = Math.round((effortEF - baseline) * 1000) / 1000;
    return { formePct, deltaEF };
}

/**
 * Compute decoupling % for efforts from the same activity (2+ efforts).
 * Efforts sorted by start_date. EF_i = (NP_i or Pavg_i) / HRavg_i
 * DEC_session = (EF_first - EF_last) / EF_first * 100
 * Valid only when: |P_last-P_first|/P_first <= 0.03 AND |time_last-time_first|/time_first <= 0.05
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
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        const efFirst = getEF(first);
        const efLast = getEF(last);
        if (efFirst == null || efLast == null || efFirst <= 0) return;
        const pFirst = getPowerUsed(first);
        const pLast = getPowerUsed(last);
        const timeFirst = first.elapsed_time ?? first.moving_time ?? 0;
        const timeLast = last.elapsed_time ?? last.moving_time ?? 0;
        let valid = true;
        if (pFirst == null || pFirst <= 0 || pLast == null) valid = false;
        else if (Math.abs(pLast - pFirst) / pFirst > 0.03) valid = false;
        if (timeFirst <= 0 || timeLast == null) valid = false;
        else if (Math.abs(timeLast - timeFirst) / timeFirst > 0.05) valid = false;
        if (!valid) return;
        const pct = Math.round((efFirst - efLast) / efFirst * 1000) / 10;
        group.forEach(e => { e.decoupling_pct = pct; });
    });
}

class SegmentAnalyzer {
    constructor() {
        this.allEfforts = [];
        this.filteredEfforts = [];
        this.currentSort = { field: 'start_date', direction: 'desc' };
        this.fallbackMode = false;
        this.selectedEffortId = null;
        this.baselineResult = null;
        
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

        const importActivityBtn = document.getElementById('importActivityBtn');
        if (importActivityBtn) {
            importActivityBtn.addEventListener('click', () => this.importFromActivity());
        }

        const z2Toggle = document.getElementById('useZ2StrictBaseline');
        if (z2Toggle) {
            z2Toggle.addEventListener('change', () => {
                this.updateReadinessUI();
                this.renderEfforts();
            });
        }

        document.getElementById('effortsTable')?.addEventListener('click', (e) => {
            if (e.target.closest('a')) return; // let links work
            const row = e.target.closest('.effort-row');
            if (!row) return;
            const id = row.dataset.effortId;
            if (id) {
                this.selectedEffortId = id === this.selectedEffortId ? null : id;
                this.updateReadinessUI();
                this.renderEfforts();
            }
        });
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

            // If forced refresh is rate-limited, fall back to plain DB read endpoint
            // so user still sees latest persisted data.
            if (forceRefresh && error.response?.status === 429) {
                try {
                    const fallbackResponse = await axios.get(`/segment/${window.segmentData.id}/efforts`);
                    const fallbackData = fallbackResponse.data;
                    this.allEfforts = fallbackData;
                    computeDecoupling(this.allEfforts);
                    this.filteredEfforts = [...this.allEfforts];
                    this.updateBikeFilterOptions();
                    this.setCachedEfforts(fallbackData);
                    this.renderEfforts();
                    this.updateStatistics();
                    this.applyFilters();
                    showNotification('Sync limited by rate limit. Showing latest database data.', 'warning');
                    return;
                } catch (fallbackError) {
                    console.error('Fallback load after 429 failed:', fallbackError);
                }
            }
            
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
        this.updateReadinessUI();
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
        this.updateReadinessUI();
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

            if (field === 'efficiency') {
                aVal = getEF(a);
                bVal = getEF(b);
            } else if (field === 'forme_pct') {
                const base = this.baselineResult?.baseline;
                aVal = base && getEF(a) ? computeReadiness(getEF(a), base)?.formePct : null;
                bVal = base && getEF(b) ? computeReadiness(getEF(b), base)?.formePct : null;
            } else if (field === 'start_date') {
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

        this.updateReadinessUI();
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
                    <td colspan="11" class="px-6 py-10 text-center text-sm text-gray-500">
                        No efforts match your current filters. Click <strong>Clear Filters</strong> to see all efforts.
                    </td>
                </tr>
            `;
            return;
        }
        
        effortsPanel.classList.remove('hidden');
        effortsCount.textContent = `(${this.filteredEfforts.length} shown / ${this.allEfforts.length} total)`;

        const baseline = this.baselineResult?.baseline;
        
        tableBody.innerHTML = this.filteredEfforts.map(effort => {
            const effortId = String(effort.id ?? `${effort.activity_id}_${effort.start_date}`);
            const selected = effortId === this.selectedEffortId;
            const { valid: z2Valid } = isZ2Strict(effort);
            const eff = getEF(effort);
            const r = baseline && eff ? computeReadiness(eff, baseline) : null;
            const formeCell = r != null ? (r.formePct >= 0 ? '+' : '') + r.formePct + '%' : '—';
            return `
            <tr class="effort-row ${selected ? 'bg-orange-50 ring-1 ring-orange-200' : ''}" data-effort-id="${effortId}">
                <td class="text-gray-900" title="${formatDate(effort.start_date)}">${formatDate(effort.start_date)}</td>
                <td class="text-gray-900">
                    <a href="https://www.strava.com/activities/${effort.activity_id}" target="_blank" class="text-orange-600 hover:text-orange-900 truncate block max-w-[3.5rem]" title="${(effort.name || '').replace(/"/g, '&quot;')} (View on Strava)">${effort.name || '—'}</a>
                </td>
                <td class="text-gray-900">${effort.bike_name || '—'}</td>
                <td class="text-gray-900 font-mono">${formatTime(effort.elapsed_time)}</td>
                <td class="text-gray-900">${effort.average_heartrate ? Math.round(effort.average_heartrate) + ' bpm' : '—'}</td>
                <td class="text-gray-900">${eff != null ? eff.toFixed(2) : '—'}</td>
                <td class="text-gray-900">${effort.average_watts ? Math.round(effort.average_watts) + ' W' : '—'}</td>
                <td class="text-gray-900">${effort.vam ? effort.vam + ' m/h' : '—'}</td>
                <td class="text-gray-900">${effort.decoupling_pct != null ? effort.decoupling_pct + '%' : '—'}</td>
                <td class="text-gray-900 col-z2" title="${z2Valid ? 'Z2 strict valid' : 'Not Z2 strict'}">${z2Valid ? '<i class="fas fa-check text-green-600"></i>' : '—'}</td>
                <td class="text-gray-900 col-forme">${formeCell}</td>
            </tr>
        `;
        }).join('');
    }
    
    /**
     * Update Readiness/Forme block: baseline, EFF today, Forme%, badge, note.
     * Toggle off = hide block. Toggle on = compute baseline from Z2-strict efforts, show values.
     */
    updateReadinessUI() {
        const block = document.getElementById('readinessBlock');
        const content = document.getElementById('readinessContent');
        const note = document.getElementById('readinessNote');
        const toggle = document.getElementById('useZ2StrictBaseline');
        if (!block || !content || !note || !toggle) return;

        if (!toggle.checked) {
            block.classList.add('hidden');
            this.baselineResult = null;
            return;
        }

        block.classList.remove('hidden');
        this.baselineResult = computeBaseline(this.filteredEfforts, READINESS_CONFIG);

        const effortToday = this.selectedEffortId
            ? this.filteredEfforts.find(e => String(e.id) === this.selectedEffortId)
            : this.filteredEfforts[0];
        const effToday = effortToday ? getEF(effortToday) : null;
        const readiness = this.baselineResult.baseline ? computeReadiness(effToday, this.baselineResult.baseline) : null;

        const baselineVal = this.baselineResult.baseline != null
            ? this.baselineResult.baseline.toFixed(3) + ' W/bpm'
            : '—';
        const effTodayVal = effToday != null ? effToday.toFixed(3) + ' W/bpm' : '—';
        let formeVal = '—';
        let deltaVal = '—';
        let badgeClass = 'bg-gray-200 text-gray-700';

        if (readiness) {
            formeVal = readiness.formePct + '%';
            deltaVal = (readiness.deltaEF >= 0 ? '+' : '') + readiness.deltaEF.toFixed(3) + ' W/bpm';
            if (readiness.formePct >= 1) badgeClass = 'bg-green-200 text-green-800';
            else if (readiness.formePct <= -5) badgeClass = 'bg-red-200 text-red-800';
            else if (readiness.formePct <= -3) badgeClass = 'bg-orange-200 text-orange-800';
        }

        content.innerHTML = `
            <div class="stat-card">
                <div class="stat-value text-sm">${baselineVal}</div>
                <div class="stat-label">Baseline EFF (W/bpm)</div>
            </div>
            <div class="stat-card">
                <div class="stat-value text-sm">${effTodayVal}</div>
                <div class="stat-label">EFF today (W/bpm)</div>
            </div>
            <div class="stat-card">
                <div class="stat-value"><span class="px-2 py-0.5 rounded ${badgeClass}">${formeVal}</span></div>
                <div class="stat-label">Forme%</div>
            </div>
            <div class="stat-card">
                <div class="stat-value text-sm">${deltaVal}</div>
                <div class="stat-label">ΔEFF</div>
            </div>
        `;

        const n = this.baselineResult.count;
        const topN = READINESS_CONFIG.baselineTopN ?? 10;
        const days = READINESS_CONFIG.baselineWindowDays ?? 120;
        note.textContent = n > 0
            ? `Baseline: median of top ${Math.min(n, topN)} / last ${days} days`
            : 'No Z2-strict efforts in window. Adjust filters or HR range.';
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

    async importFromActivity() {
        const raw = prompt('Enter the Strava Activity ID to import (e.g. 17520224749):');
        if (!raw) return;
        const activityId = raw.trim();
        if (!/^\d+$/.test(activityId)) {
            showNotification('Invalid activity ID — must be a number', 'error');
            return;
        }
        try {
            showNotification(`Importing activity ${activityId}…`, 'info');
            const segmentId = window.segmentData.id;
            const resp = await fetch(`/segment/${segmentId}/import-activity`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ activity_id: activityId }),
            });
            const data = await resp.json();
            if (!resp.ok) {
                showNotification(`Import failed: ${data.error}`, 'error');
                return;
            }
            const imported = data.efforts || [];
            if (imported.length > 0) {
                const byId = new Map(this.allEfforts.map(e => [String(e.id), e]));
                imported.forEach(effort => byId.set(String(effort.id), effort));
                this.allEfforts = Array.from(byId.values()).sort(
                    (a, b) => new Date(b.start_date) - new Date(a.start_date)
                );
                computeDecoupling(this.allEfforts);
                this.filteredEfforts = [...this.allEfforts];
                this.updateBikeFilterOptions();
                this.renderEfforts();
                this.updateStatistics();
                this.applyFilters();
                this.setCachedEfforts(this.allEfforts);
            }
            showNotification(`Imported ${data.imported} effort(s)`, 'success');
            // Then request latest DB view without forcing a heavy refresh path.
            await this.loadEfforts(false);
        } catch (err) {
            console.error('Import error:', err);
            showNotification('Import error — see console', 'error');
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
