const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { downloadVideo } = require('./utils/mediaUtils');
const { JSDOM } = require('jsdom');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = 3000;

// JSON解析
app.use(express.json());

// 提供静态文件服务
app.use(express.static('public'));
app.use('/temp', express.static(path.join(__dirname, 'temp'))); // 服务 temp 目录

// 检测缓存文件夹是否创建
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

/**
 * 获取视频或音频下载链接
 */
async function getDownloadUrl(id, type) {
  try {
    const baseUrl = type === 'video'
      ? `https://music.douyin.com/qishui/share/ugc_video?&ugc_video_id=${id}`
      : `https://music.douyin.com/qishui/share/track?track_id=${id}`;

    const playlistData = await axios.get(baseUrl);

    const { document } = (new JSDOM(playlistData.data)).window;
    const scriptElements = document.querySelectorAll('script');
    let routerData = null;
    scriptElements.forEach(script => {
      if (script.textContent.includes("window._ROUTER_DATA")) {
        const jsonString = script.textContent.match(/window._ROUTER_DATA\s*=\s*(\{.*\})/s);
        if (jsonString && jsonString[1]) {
          try {
            routerData = JSON.parse(jsonString[1]);
          } catch (error) {
            console.error("解析 JSON 出错:", error.message);
          }
        }
      }
    });
    if (routerData) {
      console.log("匹配到的 _ROUTER_DATA 数据:", routerData);
    } else {
      console.error("无法找到 _ROUTER_DATA 数据。");
    }

    const downloadUrl = type === 'video'
      ? routerData.loaderData.ugc_video_page.videoOptions.url
      : routerData.loaderData.track_page.audioWithLyricsOption.url;

    if (downloadUrl) {
      return downloadUrl
        .replace(/\\u002F/g, "/")
        .replace(/%7C/g, "|")
        .replace(/%3D/g, "=");
    }
    console.error('未找到下载链接:', routerData);

  } catch (error) {
    console.error('获取下载链接失败:', error.message);
  }
  return null;
}

/**
 * 解析用户分享链接并提取歌单信息
 */
app.get('/getPlaylist', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const matchedUrls = url.match(/(https?:\/\/[^\s]+)/g);
  if (!matchedUrls) return res.status(400).json({ error: 'No valid URL found' });

  try {
    const extractedUrl = matchedUrls[0];
    const { data } = await axios.get(extractedUrl);
    const $ = cheerio.load(data);
    const metaContent = $('meta[name="url"]').attr('content');
    const coverUrl = $('meta[property="og:image"]').attr('content');
    const playlistUrl = `https://music.douyin.com${metaContent}`;
    const playlistData = await axios.get(playlistUrl);

    const { document } = (new JSDOM(playlistData.data)).window;
    const scriptElements = document.querySelectorAll('script');
    let routerData = null;
    scriptElements.forEach(script => {
      if (script.textContent.includes("window._ROUTER_DATA")) {
        const jsonString = script.textContent.match(/window._ROUTER_DATA\s*=\s*(\{.*\})/s);
        if (jsonString && jsonString[1]) {
          try {
            routerData = JSON.parse(jsonString[1]);
          } catch (error) {
            console.error("解析 JSON 出错:", error.message);
          }
        }
      }
    });
    if (routerData) {
      console.log("匹配到的 _ROUTER_DATA 数据:", routerData);
    } else {
      console.error("无法找到 _ROUTER_DATA 数据。");
    }

    const playlistInfo = routerData.loaderData.playlist_page.playlistInfo;
    const medias = routerData.loaderData.playlist_page.medias;

    const result = {
      playlist_info: {
        title: playlistInfo.title,
        track_count: playlistInfo.count_tracks,
        owner_name: playlistInfo.owner.nickname,
        create_time: playlistInfo.create_time,
        update_time: playlistInfo.update_time,
        coverUrl: coverUrl
      },
      items: [],
    };

    let processedCount = 0;
    const totalItems = medias.length;
    let lastProgress = 0;

    for (let media of medias) {
      try {
        const downloadUrl = await getDownloadUrl(
          media.type === 'track' ? media.entity.track.id : media.entity.video.video_id,
          media.type
        );

        result.items.push({
          id: media.type === 'track' ? media.entity.track.id : media.entity.video.video_id,
          type: media.type === 'track' ? '音频' : '视频',
          name: media.type === 'track' ? media.entity.track.name : media.entity.video.description,
          artists: media.entity.track ? media.entity.track.artists.map(a => a.name).join(', ') : null,
          duration: Math.floor((media.entity.track ? media.entity.track.duration : media.entity.video.duration) / 1000), // 将秒数取整
          album_name: media.entity.track?.album.name,
          cover_url: media.entity.track?.album.url_cover?.urls[0],
          download_url: downloadUrl,
        });

        // 更新进度
        processedCount++;
        const progress = Math.floor((processedCount / totalItems) * 100);

        if (progress > lastProgress) {
          lastProgress = progress;
          io.emit('fetchingProgress', { progress }); // 获取歌单进度
        }

      } catch (error) {
        console.error(`获取 ${media.type} 的下载链接失败:`, error.message);
      }
    }

    res.json(result);
  } catch (error) {
    console.error('解析歌单失败:', error.message);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * 批量下载并打包选择的音频
 */
app.post('/downloadSelected', async (req, res) => {
  const { tracks } = req.body;
  if (!tracks || tracks.length === 0) return res.status(400).json({ error: 'No tracks selected' });

  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;

  const zipFilePath = path.join(__dirname, 'temp', `${timestamp}.zip`);
  const output = fs.createWriteStream(zipFilePath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  archive.pipe(output);

  const tempFilePaths = [];
  const totalFiles = tracks.length;
  let processedFiles = 0;

  try {
    for (const track of tracks) {
      if (!track.download_url || !track.name) {
        console.warn(`Skipping track with missing name or download_url:`, track);
        continue;
      }

      const sanitizedFileName = track.name.replace(/[\/\\:*?"<>|]/g, '');
      const isVideo = track.type === '视频';
      const tempFilePath = path.join(__dirname, 'temp', `${sanitizedFileName}.${isVideo ? 'mp4' : 'mp3'}`);
      const outputAudioPath = path.join(__dirname, 'temp', `${sanitizedFileName}.mp3`);

      // 如果是视频，先下载视频再提取音频
      if (isVideo) {
        await downloadFile(track.download_url, tempFilePath);
        ffmpeg.setFfmpegPath(ffmpegInstaller.path);

        await new Promise((resolve, reject) => {
          ffmpeg(tempFilePath)
            .noVideo()
            .audioCodec('libmp3lame')
            .save(outputAudioPath)
            .on('end', resolve)
            .on('error', reject);
        });

        // 将音频文件添加到压缩包
        archive.file(outputAudioPath, { name: `${sanitizedFileName}.mp3` });
        tempFilePaths.push(tempFilePath, outputAudioPath);
      } else {
        // 如果是音频，直接下载并添加到压缩包
        await downloadFile(track.download_url, tempFilePath);
        archive.file(tempFilePath, { name: `${sanitizedFileName}.mp3` });
        tempFilePaths.push(tempFilePath);
      }

      processedFiles++;
      const progress = Math.floor((processedFiles / totalFiles) * 100);
      io.emit('packagingProgress', { progress });
    }

    await archive.finalize();

    output.on('close', () => {
      tempFilePaths.forEach(filePath => {
        fs.unlink(filePath, (err) => {
          if (err) console.error(`Error deleting file ${filePath}:`, err);
        });
      });

      res.json({ zipUrl: `/temp/${timestamp}.zip` });
    });
  } catch (error) {
    console.error('Error creating ZIP:', error.message);
    res.status(500).json({ error: '无法生成ZIP文件' });
  }
});

/**
 * 下载音频
 */
app.get('/download', async (req, res) => {
  const { url, fileName } = req.query;

  if (!url) return res.status(400).json({ error: 'URL is required' });

  // 设置文件名，默认文件名为 "download.mp4"（如果未提供 fileName）
  const safeFileName = fileName
    ? `${fileName.replace(/[\/\\:*?"<>|]/g, '')}.mp4` // 移除不安全字符
    : 'download.mp4';

  try {
    const response = await axios.get(url, {
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://music.douyin.com',
      },
    });

    // 设置安全的文件名
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeFileName)}"`);
    response.data.pipe(res); // 将文件流传输到响应中
  } catch (error) {
    console.error('下载失败:', error.message);
    res.status(500).json({ error: '下载失败' });
  }
});

/**
 * 下载视频并提取音频
 */
app.get('/downloadAudio', async (req, res) => {
  const { url, title } = req.query;
  if (!url || !title) return res.status(400).json({ error: 'URL and title are required' });

  // 格式化客户端传入的文件名作为下载时的显示名称
  const displayFileName = sanitizeFileName(title);
  // 使用时间戳命名实际保存的文件，避免特殊字符问题
  const timestamp = Date.now();
  const tempVideoPath = path.join(__dirname, 'temp', `${timestamp}.mp4`);
  const outputAudioPath = path.join(__dirname, 'temp', `${timestamp}.mp3`);

  try {
    await downloadVideo(url, tempVideoPath);
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);

    const ffmpegCommand = ffmpeg(tempVideoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .save(outputAudioPath);

    ffmpegCommand.on('progress', progress => {
      const percentComplete = Math.floor(progress.percent || 0);
      io.emit('audioDownloadProgress', { progress: percentComplete });
    });

    await new Promise((resolve, reject) => {
      ffmpegCommand.on('end', resolve).on('error', reject);
    });

    // 返回音频文件的下载路径及显示名称
    res.json({ downloadUrl: `/temp/${timestamp}.mp3`, displayFileName: `${displayFileName}.mp3` });

    // 定时删除临时文件
    setTimeout(() => {
      [tempVideoPath, outputAudioPath].forEach(file => fs.existsSync(file) && fs.unlinkSync(file));
    }, 180000);

  } catch (error) {
    console.error('下载或音频提取过程失败:', error.message);
    res.status(500).json({ error: '音频提取失败' });
  }
});

// 辅助函数：格式化文件名
function sanitizeFileName(name) {
  return name.replace(/[\/\\:*?"<>|]/g, '').trim();
}

// 下载文件到指定路径
async function downloadFile(url, filePath) {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
  });
  const writer = fs.createWriteStream(filePath);

  return new Promise((resolve, reject) => {
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// 修改获取歌词的函数
async function getLyrics(trackId) {
  try {
    const url = `https://music.douyin.com/qishui/share/track?track_id=${trackId}`;
    const { data } = await axios.get(url);
    const dom = new JSDOM(data);
    const document = dom.window.document;

    // 获取歌曲信息
    const title = document.querySelector('.title')?.textContent || '';
    const artist = document.querySelector('.artist-name-max')?.textContent || '';
    
    // 获取所有歌词行
    const lyricsElements = document.querySelectorAll('.ssr-lyric');
    let lyrics = '';
    
    if (lyricsElements.length > 0) {
      lyrics = Array.from(lyricsElements)
        .map(el => el.textContent)
        .join('\n');
    } else {
      lyrics = '纯音乐，请欣赏~';
    }

    return {
      title,
      artist,
      lyrics
    };
  } catch (error) {
    console.error('获取歌词失败:', error);
    throw error;
  }
}

// 添加下载歌词的路由
app.get('/downloadLyrics', async (req, res) => {
  const { trackId } = req.query;
  if (!trackId) {
    return res.status(400).json({ error: '缺少 trackId 参数' });
  }

  try {
    const { title, artist, lyrics } = await getLyrics(trackId);
    const fileName = `${title}-${artist}.txt`;
    const sanitizedFileName = sanitizeFileName(fileName);
    
    // 创建临时文件
    const tempPath = path.join(__dirname, 'temp', sanitizedFileName);
    fs.writeFileSync(tempPath, lyrics, 'utf8');

    // 设置响应头
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(sanitizedFileName)}`);
    
    // 发送文件
    res.sendFile(tempPath, (err) => {
      if (err) {
        console.error('发送文件时出错:', err);
      }
      // 删除临时文件
      fs.unlink(tempPath, (unlinkErr) => {
        if (unlinkErr) {
          console.error('删除临时文件时出错:', unlinkErr);
        }
      });
    });

  } catch (error) {
    console.error('下载歌词失败:', error);
    res.status(500).json({ error: '下载歌词失败' });
  }
});

server.listen(port, () => console.log(`Server is running on http://localhost:${port}`));
