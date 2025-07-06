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

    // 遍历所有script标签寻找_ROUTER_DATA
    scriptElements.forEach(script => {
      const content = script.textContent;
      if (content && content.includes('_ROUTER_DATA')) {
        try {
          const match = content.match(/_ROUTER_DATA\s*=\s*({[\s\S]*?});/);
          if (match && match[1]) {
            routerData = JSON.parse(match[1]);
            console.log('成功提取到_ROUTER_DATA');
            console.log('_ROUTER_DATA数据结构:', Object.keys(routerData));
          }
        } catch (error) {
          console.error('解析_ROUTER_DATA时出错:', error);
        }
      }
    });

    if (!routerData) {
      console.error('无法找到_ROUTER_DATA数据');
      return null;
    }

    // 修改验证逻辑以适应新的数据结构
    let downloadUrl;
    if (type === 'video') {
      if (!routerData.loaderData?.ugc_video_page?.videoOptions?.url) {
        console.error('视频数据结构不正确:', routerData);
        return null;
      }
      downloadUrl = routerData.loaderData.ugc_video_page.videoOptions.url;
    } else {
      // 音频类型
      if (!routerData.loaderData?.track_page?.audioWithLyricsOption?.url) {
        console.error('音频数据结构不正确:', routerData);
        return null;
      }
      downloadUrl = routerData.loaderData.track_page.audioWithLyricsOption.url;
    }

    if (downloadUrl) {
      return downloadUrl
        .replace(/\\u002F/g, "/")
        .replace(/%7C/g, "|")
        .replace(/%3D/g, "=");
    }

    console.error('未找到下载链接:', routerData);
    return null;

  } catch (error) {
    console.error('获取下载链接失败:', error.message);
    return null;
  }
}

/**
 * 解析用户分享链接并提取歌单信息
 */
app.get('/getPlaylist', async (req, res) => {
  const { url, page = 1, pageSize = 10 } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const matchedUrls = url.match(/(https?:\/\/[^\s]+)/g);
  if (!matchedUrls) return res.status(400).json({ error: 'No valid URL found' });

  try {
    const extractedUrl = matchedUrls[0];
    console.log('提取到的URL:', extractedUrl);
    const { data } = await axios.get(extractedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 10000 // 10秒超时
    });
    
    const $ = cheerio.load(data);
    
    // 检查meta标签是否存在
    const metaContent = $('meta[name="url"]').attr('content');
    if (!metaContent) {
      console.error('未找到meta[name="url"]标签');
      return res.status(400).json({ error: '无法解析分享链接，请确认链接正确' });
    }
    
    const coverUrl = $('meta[property="og:image"]').attr('content');
    
    // 修复这里的URL拼接
    const playlistUrl = metaContent.startsWith('http') 
      ? metaContent 
      : `https://music.douyin.com${metaContent}`;
      
    console.log('请求歌单URL:', playlistUrl); // 添加日志以便调试
    
    const playlistData = await axios.get(playlistUrl);

    const { document } = (new JSDOM(playlistData.data)).window;
    const scriptElements = document.querySelectorAll('script');
    let routerData = null;

    // 遍历所有script标签寻找_ROUTER_DATA
    scriptElements.forEach(script => {
      const content = script.textContent;
      if (content && content.includes('_ROUTER_DATA')) {
        try {
          // 使用正则表达式提取_ROUTER_DATA的值
          const match = content.match(/_ROUTER_DATA\s*=\s*({[\s\S]*?});/);
          if (match && match[1]) {
            routerData = JSON.parse(match[1]);
            console.log('成功提取到_ROUTER_DATA，请求页码:', page);
          }
        } catch (error) {
          console.error('解析_ROUTER_DATA时出错:', error);
        }
      }
    });

    if (!routerData) {
      console.error('无法找到_ROUTER_DATA数据');
      console.log('请求页码:', page);
      console.log('页面内容长度:', playlistData.data.length);
      console.log('页面是否包含_ROUTER_DATA关键字:', playlistData.data.includes('_ROUTER_DATA'));
      // 只在调试时输出完整页面内容
      if (process.env.DEBUG) {
        console.log('页面内容:', playlistData.data);
      }
      return res.status(400).json({ error: '无法解析歌单数据，请确认链接正确' });
    }

    // 修改数据结构验证
    if (!routerData.loaderData?.playlist_page && !routerData.loaderData?.track_page) {
      console.error('_ROUTER_DATA结构不正确:', routerData);
      return res.status(400).json({ error: '歌单数据格式不正确' });
    }

    // 根据不同的数据结构获取信息
    let playlistInfo, medias;
    if (routerData.loaderData.playlist_page) {
      playlistInfo = routerData.loaderData.playlist_page.playlistInfo;
      medias = routerData.loaderData.playlist_page.medias;
    } else {
      // 处理单曲的情况
      const trackPage = routerData.loaderData.track_page;
      playlistInfo = {
        title: trackPage.metaData?.title || '单曲播放',
        count_tracks: 1,
        owner: { nickname: trackPage.metaData?.artist || '未知艺术家' },
        create_time: Date.now() / 1000,
        update_time: Date.now() / 1000
      };
      medias = [{
        type: 'track',
        entity: {
          track: {
            id: trackPage.track_id,
            name: trackPage.metaData?.title,
            artists: [{ name: trackPage.metaData?.artist }],
            duration: trackPage.metaData?.duration || 0,
            album: { name: trackPage.metaData?.album, url_cover: trackPage.metaData?.cover }
          }
        }
      }];
    }

    // 分页参数处理
    const currentPage = parseInt(page) || 1;
    const size = parseInt(pageSize) || 10;
    
    // 使用实际获取到的歌曲数量进行分页（API实际返回的数据）
    const actualItems = medias.length;
    const totalItems = actualItems; // 基于实际数据进行分页
    const totalPages = Math.ceil(totalItems / size);
    
    // 进行本地分页处理
    const startIndex = (currentPage - 1) * size;
    const endIndex = Math.min(startIndex + size, totalItems);
    
    // 对媒体数据进行分页切片
    const paginatedMedias = medias.slice(startIndex, endIndex);
    
    console.log(`分页信息: 第${currentPage}页, 每页${size}首, 总共${totalItems}首歌曲, 共${totalPages}页`);
    console.log(`索引范围: ${startIndex} - ${endIndex}, 实际获取: ${paginatedMedias.length}首`);
    


    const result = {
      playlist_info: {
        title: playlistInfo.title,
        track_count: playlistInfo.count_tracks,
        actual_count: actualItems,
        owner_name: playlistInfo.owner.nickname,
        create_time: playlistInfo.create_time,
        update_time: playlistInfo.update_time,
        coverUrl: coverUrl
      },
      items: [],
      pagination: {
        currentPage: currentPage,
        pageSize: size,
        totalItems: totalItems,
        totalPages: totalPages,
        hasNext: currentPage < totalPages,
        hasPrev: currentPage > 1
      }
    };

    let processedCount = 0;
    const paginatedTotal = paginatedMedias.length;
    let lastProgress = 0;

    for (let media of paginatedMedias) {
      try {
        let downloadUrl = null;
        try {
          downloadUrl = await getDownloadUrl(
            media.type === 'track' ? media.entity.track.id : media.entity.video.video_id,
            media.type
          );
        } catch (urlError) {
          console.error(`获取 ${media.type} 的下载链接失败:`, urlError.message);
          downloadUrl = null; // 设置为null，但仍然添加到结果中
        }

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
        const progress = Math.floor((processedCount / paginatedTotal) * 100);

        if (progress > lastProgress) {
          lastProgress = progress;
          io.emit('fetchingProgress', { progress }); // 获取歌单进度
        }

      } catch (error) {
        console.error(`处理 ${media.type} 时出错:`, error.message);
        // 即使出错也要增加计数，确保进度正常
        processedCount++;
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

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    // 设置文件名，移除不安全字符
    const safeFileName = fileName
      ? `${fileName.replace(/[\/\\:*?"<>|]/g, '')}.mp3` // 改为.mp3扩展名
      : 'download.mp3';

    // 添加更多请求头以模拟浏览器行为
    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Referer': 'https://music.douyin.com/',
        'Origin': 'https://music.douyin.com'
      },
      timeout: 30000 // 增加超时时间到30秒
    });

    // 设置响应头
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeFileName)}`);
    
    // 添加错误处理
    response.data.on('error', (error) => {
      console.error('Stream error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: '下载过程中出错' });
      }
    });

    // 流式传输数据
    response.data.pipe(res);

  } catch (error) {
    console.error('下载失败:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: '下载失败，请重试' });
    }
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
