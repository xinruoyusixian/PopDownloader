const socket = io();

function sanitizeFileName(name) {
  return name.replace(/[\/\\:*?"<>|]/g, '').trim();
}

new Vue({
  el: '#app',
  data: {
    urlInput: '',
    loading: false,
    progress: 0,
    progressStatus: '', // 用于区分当前的进度状态 ("fetching"、"packaging" 或 "audioDownloading")
    playlistInfo: {},
    trackList: [],
    selectedTracks: [],
    showDialog: false, // 控制对话框的可见性
  },
  methods: {
    async fetchPlaylist() {
      if (!this.urlInput.trim()) return this.$message.warning('请输入有效的歌单链接');

      this.loading = true;
      this.progress = 0;
      this.progressStatus = 'fetching'; // 设置状态为获取歌单
      this.playlistInfo = {};
      this.trackList = [];

      try {
        const response = await fetch(`/getPlaylist?url=${encodeURIComponent(this.urlInput)}`);
        const data = await response.json();

        if (data.error) return this.$message.error(data.error);

        this.playlistInfo = {
          coverUrl: data.playlist_info.coverUrl, // 确保与服务器的字段匹配
          title: data.playlist_info.title,
          ownerName: data.playlist_info.owner_name,
          trackCount: data.playlist_info.track_count,
          createTime: new Date(data.playlist_info.create_time * 1000).toLocaleString(),
          updateTime: new Date(data.playlist_info.update_time * 1000).toLocaleString()
        };

        this.trackList = data.items.map(item => ({
          ...item,
          durationFormatted: this.formatDuration(item.duration)
        }));
      } catch (error) {
        console.error('Error fetching playlist:', error);
        this.$message.error('无法获取歌单信息');
      } finally {
        this.loading = false;
        this.progress = 0; // 重置进度
        this.progressStatus = ''; // 重置状态
      }
    },

    formatDuration(duration) {
      const minutes = Math.floor(duration / 60);
      const seconds = Math.floor(duration % 60);
      return `${minutes}分钟${seconds}秒`;
    },

    downloadSelected() {
      if (this.selectedTracks.length === 0) return this.$message.warning('请至少选择一首歌曲');

      this.progress = 0;
      this.progressStatus = 'packaging'; // 设置状态为打包下载

      const selected = this.selectedTracks.map(track => ({
        id: track.id,
        name: track.name,
        type: track.type,
        download_url: track.download_url
      }));

      fetch('/downloadSelected', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracks: selected })
      })
        .then(response => response.json())
        .then(data => {
          if (data.error) return this.$message.error(data.error);
          window.location.href = data.zipUrl;
        })
        .catch(error => {
          console.error('Error creating ZIP file:', error);
          this.$message.error('无法生成ZIP文件');
        })
        .finally(() => {
          this.progress = 0;
          this.progressStatus = ''; // 清除状态
        });
    },

    handleSelectionChange(val) {
      this.selectedTracks = val;
    },

    download(track) {
      if (track.download_url) {
        window.open(`/download?url=${encodeURIComponent(track.download_url)}&fileName=${encodeURIComponent(track.title || track.name)}`, '_blank');
      }
    },

    async downloadAudio(track) {
      if (track.download_url) {
        this.progress = 0;
        this.progressStatus = 'audioDownloading';

        try {
          // 使用 sanitizeFileName 格式化文件名
          const fileName = sanitizeFileName(track.title || track.name);
          const response = await fetch(`/downloadAudio?url=${encodeURIComponent(track.download_url)}&title=${encodeURIComponent(fileName)}`);
          const data = await response.json();

          if (data.error) {
            this.$message.error(data.error);
            return;
          }

          // 通过返回的 URL 和显示名称下载音频文件
          const downloadLink = document.createElement('a');
          downloadLink.href = data.downloadUrl;
          downloadLink.download = data.displayFileName; // 使用服务器返回的显示名称
          downloadLink.click();

          // 下载完成后重置状态
          this.progressStatus = '';
          this.progress = 0;

        } catch (error) {
          console.error('音频下载出错:', error);
          this.$message.error('音频下载失败');
        }
      }
    }
  },

  mounted() {
    // 在页面加载时显示对话框
    this.showDialog = true;

    // 监听获取歌单的进度
    socket.on('fetchingProgress', data => {
      if (this.progressStatus === 'fetching') {
        this.progress = data.progress;
      }
    });

    // 监听打包进度
    socket.on('packagingProgress', data => {
      if (this.progressStatus === 'packaging') {
        this.progress = data.progress;
      }
    });

    // 监听音频转换进度
    socket.on('audioDownloadProgress', data => {
      if (this.progressStatus === 'audioDownloading') {
        this.progress = data.progress;
      }
    });
  }
});
