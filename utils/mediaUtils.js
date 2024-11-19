// utils/mediaUtils.js

const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const path = require('path');

// 配置 ffmpeg 路径
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// 下载视频到指定路径
async function downloadVideo(url, outputPath) {
  const response = await axios({
    method: 'get',
    url: url,
    responseType: 'stream',
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://music.douyin.com',
    }
  });

  const writer = fs.createWriteStream(outputPath);
  return new Promise((resolve, reject) => {
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// 从视频文件中提取音频
function extractAudioFromVideo(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .save(audioPath)
      .on('end', resolve)
      .on('error', reject);
  });
}

module.exports = {
  downloadVideo,
  extractAudioFromVideo,
};