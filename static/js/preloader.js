// Preloader for instant cache-based page rendering

class SegmentPreloader {
    constructor() {
        this.segmentCacheKey = 'segment_cache_';
        this.effortsCacheKey = 'efforts_cache_';
    }
    
    /**
     * Preload segment data if available in cache
     */
    preloadSegmentData(segmentId) {
        // Try to load segment info from cache
        const cachedSegment = this.getCachedSegment(segmentId);
        if (cachedSegment) {
            this.renderSegmentHeader(cachedSegment);
        }
        
        // Try to load efforts from cache
        const cachedEfforts = this.getCachedEfforts(segmentId);
        if (cachedEfforts && cachedEfforts.length > 0) {
            this.renderEffortsPreview(cachedEfforts);
            this.showCacheNotice();
        }
    }
    
    getCachedSegment(segmentId) {
        try {
            const cacheData = localStorage.getItem(`${this.segmentCacheKey}${segmentId}`);
            if (cacheData) {
                const parsed = JSON.parse(cacheData);
                const cacheTime = new Date(parsed.timestamp);
                const now = new Date();
                const ageHours = (now - cacheTime) / (1000 * 60 * 60);
                
                if (ageHours < 24) {
                    return parsed.segment;
                }
            }
        } catch (error) {
            console.warn('Error reading cached segment:', error);
        }
        return null;
    }
    
    getCachedEfforts(segmentId) {
        try {
            const cacheData = localStorage.getItem(`${this.effortsCacheKey}${segmentId}`);
            if (cacheData) {
                const parsed = JSON.parse(cacheData);
                const cacheTime = new Date(parsed.timestamp);
                const now = new Date();
                const ageHours = (now - cacheTime) / (1000 * 60 * 60);
                
                if (ageHours < 24) {
                    return parsed.efforts;
                }
            }
        } catch (error) {
            console.warn('Error reading cached efforts:', error);
        }
        return null;
    }
    
    renderSegmentHeader(segment) {
        // Update page title immediately
        document.title = `${segment.name} - Strava Segment Analyzer`;
        
        // Update any segment info elements that might be server-rendered
        const segmentIdElements = document.querySelectorAll('.segment-id');
        segmentIdElements.forEach(el => el.textContent = segment.id);
        
        const segmentNameElements = document.querySelectorAll('.segment-name');
        segmentNameElements.forEach(el => el.textContent = segment.name);
    }
    
    renderEffortsPreview(efforts) {
        // Show a preview of efforts count
        const previewElement = document.getElementById('effortsPreview');
        if (previewElement) {
            previewElement.textContent = `${efforts.length} efforts (cached)`;
            previewElement.classList.remove('hidden');
        }
    }
    
    showCacheNotice() {
        // Show a subtle notice that cached data is being displayed
        const notice = document.createElement('div');
        notice.className = 'fixed bottom-4 right-4 bg-blue-500 text-white px-4 py-2 rounded-lg shadow-lg z-50 text-sm';
        notice.innerHTML = '<i class="fas fa-bolt mr-2"></i>Loaded from cache';
        notice.id = 'cacheNotice';
        document.body.appendChild(notice);
        
        // Remove after 3 seconds
        setTimeout(() => {
            const element = document.getElementById('cacheNotice');
            if (element) {
                element.remove();
            }
        }, 3000);
    }
}

// Initialize preloader
window.segmentPreloader = new SegmentPreloader();

// Auto-preload if we're on a segment page
document.addEventListener('DOMContentLoaded', () => {
    if (window.location.pathname.includes('/segment/')) {
        const segmentId = window.location.pathname.split('/').pop();
        if (segmentId && !isNaN(segmentId)) {
            window.segmentPreloader.preloadSegmentData(segmentId);
        }
    }
}); 