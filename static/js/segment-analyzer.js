// Segment Analyzer JavaScript

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
        const filterInputs = ['minHeartRate', 'maxHeartRate', 'minPower', 'maxPower', 'startDate', 'endDate'];
        filterInputs.forEach(id => {
            document.getElementById(id).addEventListener('input', 
                debounce(() => this.applyFilters(), 500)
            );
        });
        
        // Sort controls
        document.querySelectorAll('[data-sort]').forEach(header => {
            header.addEventListener('click', () => {
                const field = header.dataset.sort;
                this.sortEfforts(field);
            });
        });
        
        // Cache management
        document.getElementById('clearCacheBtn').addEventListener('click', () => this.clearCache());
    }
    
    async loadEfforts() {
        const loadingIndicator = document.getElementById('loadingIndicator');
        const errorPanel = document.getElementById('errorPanel');
        
        // First, try to load from client-side cache for instant display
        const cachedData = this.getCachedEfforts();
        if (cachedData && cachedData.length > 0) {
            console.log('Loading from cache for instant display');
            this.allEfforts = cachedData;
            this.filteredEfforts = [...this.allEfforts];
            this.renderEfforts();
            this.updateStatistics();
            this.applyFilters();
            
            // Show cache info banner
            this.showCacheInfoBanner();
            
            // Show refresh indicator instead of loading
            this.showRefreshIndicator();
        } else {
            // No cache, show full loading
            loadingIndicator.classList.remove('hidden');
        }
        
        // Then fetch fresh data in the background
        try {
            errorPanel.classList.add('hidden');
            
            const fallbackParam = this.fallbackMode ? '?fallback=true' : '';
            const response = await axios.get(`/segment/${window.segmentData.id}/efforts${fallbackParam}`);
            const freshData = response.data;
            
            // Update with fresh data
            this.allEfforts = freshData;
            this.filteredEfforts = [...this.allEfforts];
            
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
            } else if (error.response?.status === 429 && !this.fallbackMode) {
                this.fallbackMode = true;
                showNotification('Rate limit exceeded. Switching to fallback mode (activity-level heart rate).', 'warning');
                setTimeout(() => this.loadEfforts(), 2000);
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
            effortsPanel.classList.add('hidden');
            return;
        }
        
        effortsPanel.classList.remove('hidden');
        effortsCount.textContent = `(${this.filteredEfforts.length} efforts)`;
        
        tableBody.innerHTML = this.filteredEfforts.map(effort => `
            <tr class="effort-row">
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    ${formatDate(effort.start_date)}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    <div class="max-w-xs truncate" title="${effort.name}">
                        ${effort.name}
                    </div>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-mono">
                    ${formatTime(effort.elapsed_time)}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    ${effort.average_heartrate ? Math.round(effort.average_heartrate) + ' bpm' : 'N/A'}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    ${effort.max_heartrate ? Math.round(effort.max_heartrate) + ' bpm' : 'N/A'}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    ${effort.average_watts ? Math.round(effort.average_watts) + ' W' : 'N/A'}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    ${effort.vam ? effort.vam + ' m/h' : 'N/A'}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    <a href="https://www.strava.com/activities/${effort.activity_id}" 
                       target="_blank" 
                       class="text-orange-600 hover:text-orange-900 transition duration-200">
                        <i class="fas fa-external-link-alt mr-1"></i>View Activity
                    </a>
                </td>
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
        const filterInputs = ['minHeartRate', 'maxHeartRate', 'minPower', 'maxPower', 'startDate', 'endDate'];
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
    
    async loadCacheStats() {
        try {
            const response = await axios.get('/cache/stats');
            const stats = response.data;
            
            document.getElementById('totalFiles').textContent = stats.total_files;
            document.getElementById('totalSize').textContent = this.formatBytes(stats.total_size);
            document.getElementById('segmentCount').textContent = stats.by_type.segment || 0;
            document.getElementById('activityCount').textContent = (stats.by_type.activity || 0) + (stats.by_type.streams || 0);
        } catch (error) {
            console.error('Error loading cache stats:', error);
        }
    }
    
    async clearCache() {
        try {
            await axios.post('/cache/clear');
            showNotification('Expired cache entries cleared', 'success');
            this.loadCacheStats(); // Refresh stats
        } catch (error) {
            console.error('Error clearing cache:', error);
            showNotification('Error clearing cache', 'error');
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