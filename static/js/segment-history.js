// Segment History Management

class SegmentHistory {
    constructor() {
        this.storageKey = 'strava-segment-history';
        this.maxHistory = 10; // Keep last 10 segments
    }
    
    /**
     * Add a segment to history
     */
    addSegment(segment) {
        const history = this.getHistory();
        
        // Create segment entry
        const segmentEntry = {
            id: segment.id,
            name: segment.name,
            distance: segment.distance,
            elevation_gain: segment.total_elevation_gain,
            city: segment.city,
            state: segment.state,
            lastViewed: new Date().toISOString()
        };
        
        // Remove if already exists (to move to front)
        const filtered = history.filter(s => s.id !== segment.id);
        
        // Add to beginning of array
        filtered.unshift(segmentEntry);
        
        // Keep only max history items
        const trimmed = filtered.slice(0, this.maxHistory);
        
        // Save to localStorage
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(trimmed));
        } catch (error) {
            console.warn('Could not save segment history to localStorage:', error);
        }
        
        // Update UI
        this.updateRecentSegmentsUI();
    }
    
    /**
     * Get segment history from localStorage
     */
    getHistory() {
        try {
            const stored = localStorage.getItem(this.storageKey);
            return stored ? JSON.parse(stored) : [];
        } catch (error) {
            console.warn('Could not load segment history from localStorage:', error);
            return [];
        }
    }
    
    /**
     * Clear all history
     */
    clearHistory() {
        try {
            localStorage.removeItem(this.storageKey);
            this.updateRecentSegmentsUI();
        } catch (error) {
            console.warn('Could not clear segment history:', error);
        }
    }
    
    /**
     * Update recent segments UI on all pages
     */
    updateRecentSegmentsUI() {
        const history = this.getHistory();
        
        // Update home page recent segments
        this.updateHomePageRecentSegments(history);
        
        // Update segment analyzer page recent segments
        this.updateAnalyzerPageRecentSegments(history);
    }
    
    /**
     * Update recent segments on home page
     */
    updateHomePageRecentSegments(history) {
        const container = document.getElementById('recentSegmentsHome');
        const list = document.getElementById('recentSegmentsHomeList');
        
        if (!container || !list) return;
        
        if (history.length === 0) {
            container.classList.add('hidden');
            return;
        }
        
        container.classList.remove('hidden');
        
        list.innerHTML = history.map(segment => `
            <div class="flex items-center justify-between p-3 bg-gray-50 rounded-md hover:bg-gray-100 transition duration-200 cursor-pointer segment-history-item" 
                 data-segment-id="${segment.id}">
                <div class="flex-1">
                    <div class="font-medium text-gray-900">${segment.name}</div>
                    <div class="text-sm text-gray-500">
                        ${(segment.distance / 1000).toFixed(2)} km • ${segment.elevation_gain}m elevation
                        ${segment.city ? ` • ${segment.city}` : ''}
                    </div>
                </div>
                <div class="text-sm text-gray-400">
                    ${this.formatRelativeTime(segment.lastViewed)}
                </div>
            </div>
        `).join('');
        
        // Add click handlers
        list.querySelectorAll('.segment-history-item').forEach(item => {
            item.addEventListener('click', () => {
                const segmentId = item.dataset.segmentId;
                window.location.href = `/segment/${segmentId}`;
            });
        });
    }
    
    /**
     * Update recent segments on analyzer page (as pills)
     */
    updateAnalyzerPageRecentSegments(history) {
        const container = document.getElementById('recentSegmentsContainer');
        const list = document.getElementById('recentSegmentsList');
        
        if (!container || !list) return;
        
        // Filter out current segment if we're on a segment page
        const currentSegmentId = window.segmentData ? window.segmentData.id : null;
        const filteredHistory = history.filter(s => s.id !== currentSegmentId);
        
        if (filteredHistory.length === 0) {
            container.classList.add('hidden');
            return;
        }
        
        container.classList.remove('hidden');
        
        // Add "Analyze Different Segment" link first if there's history
        const analyzeNewLink = filteredHistory.length > 0 ? 
            '<a href="/" class="inline-flex items-center px-3 py-1 rounded-full text-sm bg-blue-100 text-blue-800 hover:bg-blue-200 transition duration-200 mr-2 mb-2"><i class="fas fa-plus mr-1"></i>New Segment</a>' : '';
        
        list.innerHTML = analyzeNewLink + filteredHistory.slice(0, 5).map(segment => `
            <span class="inline-flex items-center px-3 py-1 rounded-full text-sm bg-orange-100 text-orange-800 hover:bg-orange-200 transition duration-200 cursor-pointer segment-pill" 
                  data-segment-id="${segment.id}" 
                  title="${segment.name} - ${(segment.distance / 1000).toFixed(2)} km">
                ${this.truncateName(segment.name, 25)}
            </span>
        `).join('');
        
        // Add click handlers
        list.querySelectorAll('.segment-pill').forEach(pill => {
            pill.addEventListener('click', () => {
                const segmentId = pill.dataset.segmentId;
                window.location.href = `/segment/${segmentId}`;
            });
        });
    }
    
    /**
     * Format relative time (e.g., "2 hours ago")
     */
    formatRelativeTime(dateString) {
        const date = new Date(dateString);
        const now = new Date();
        const diffMs = now - date;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffMinutes = Math.floor(diffMs / (1000 * 60));
        
        if (diffDays > 0) {
            return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
        } else if (diffHours > 0) {
            return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
        } else if (diffMinutes > 0) {
            return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
        } else {
            return 'Just now';
        }
    }
    
    /**
     * Truncate segment name for display
     */
    truncateName(name, maxLength) {
        if (name.length <= maxLength) return name;
        return name.substring(0, maxLength - 3) + '...';
    }
}

// Global instance
window.segmentHistory = new SegmentHistory();

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    // Add current segment to history if we're on a segment page
    if (window.segmentData) {
        window.segmentHistory.addSegment(window.segmentData);
    }
    
    // Update UI for any existing history
    window.segmentHistory.updateRecentSegmentsUI();
}); 