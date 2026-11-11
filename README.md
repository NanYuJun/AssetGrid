# AssetGrid

AssetGrid is a browser-only image grid editor for turning photos and other image assets into a finished collage. It runs entirely in the browser and keeps works, custom layouts, and image assets on the local device. No account, upload server, or backend is required.

[Chinese documentation](#assetgrid-中文说明)

## Features

- Create a canvas in square, landscape, or portrait format and set its dimensions before adding images.
- Start from built-in layouts, or create a custom template with up to five rows and five cells per row.
- Resize rows and cells directly on the canvas. When a cell is removed, remaining cells in that row share the available width evenly.
- Upload a JPG, PNG, or WebP image to any cell, or reuse an image from the local asset library.
- Move images freely inside their cells, pinch to zoom on touch screens, and set zoom between 20% and 400% from a numeric field.
- Read the distance from each side of a cell to the placed image and set a side distance directly in pixels.
- Set canvas width and height, gap width, background color, divider width, and divider color.
- Export the complete grid as PNG or JPG. Use the JSON backup to move an editable project to another computer.
- Autosave projects and their previews in IndexedDB. Rename, copy, search through template-filtered history, or reopen a work from the left sidebar.

## Tech Stack

- Vue 3
- Vite
- IndexedDB
- HTML Canvas

The application has no server-side dependency. Project data and uploaded image files stay in the current browser's storage.

## Quick Start

Requires Node.js 20 or later.

```sh
git clone https://github.com/NanYuJun/AssetGrid.git
cd AssetGrid
npm install
npm run dev
```

Open the address printed by Vite. For a production build:

```sh
npm run build
npm run preview
```

The production output is written to `dist/`.

## Usage

1. Choose a preset layout from the left sidebar, or create and save a custom template. Template layouts and creation history are separated into independently scrolling sections; preset templates and personal templates scroll together.
2. Set the canvas dimensions and visual settings. Drag the separators in the canvas to adjust row and column proportions.
3. Select a cell and upload an image or choose one from the asset library. Drag the image to reposition it, and adjust the numeric zoom or the four side distances when needed.
4. Use **Save image** to export the finished grid as PNG or JPG. Export JSON for a portable editable backup that includes the images used by the project.
5. Return to earlier works from creation history. Changes are saved to IndexedDB automatically.

If browser storage is full, export the JSON backup before closing the page. A JSON import creates a new work and does not overwrite an existing one.

## Project Structure

```text
src/
├── App.vue          # Editor UI and interaction state
├── main.js          # Vue entry point
├── styles.css       # Responsive visual design
└── lib/
    ├── canvas.js    # Grid geometry, image placement, and rendering
    └── db.js        # IndexedDB persistence
```

## Data and Privacy

- Works, custom templates, previews, and image files are stored in the browser's IndexedDB.
- No image is uploaded to a server by the application.
- Clearing browser site data removes local works and assets. Export JSON before clearing browser data or moving to another device.

## License

Released under the [Apache License 2.0](./LICENSE).

---

## AssetGrid 中文说明

AssetGrid 是一个纯前端图片宫格编辑器，用于把图片快速整理成统一尺寸的宫格作品。所有编辑和存储都在当前浏览器内完成，无需登录，也不依赖后端服务。

### 功能

- 新建正方形、横向或纵向画布，并在编辑前设置画布尺寸。
- 使用内置版式，或创建最多 5 行、每行最多 5 格的 DIY 模板。
- 在画布中拖动分隔线调整行列比例；删除格子后，同排剩余格子均分该行宽度。
- 为每个格子上传 JPG、PNG 或 WebP 图片，或复用素材库中的已有图片。
- 在格内自由拖动图片，支持触屏双指缩放；缩放比例可直接输入，范围为 20%–400%。
- 查看图片相对格子四边的像素距离，并直接输入边距数值调整图片位置。
- 设置画布宽高、格子间距、背景颜色、分割线宽度和分割线颜色。
- 导出完整宫格为 PNG 或 JPG；导出包含图片的 JSON 备份，换电脑后仍可继续编辑。
- 作品自动保存在 IndexedDB，可在左侧创作历史中按模板查找、重命名、复制或继续编辑。

### 技术栈

- Vue 3
- Vite
- IndexedDB
- HTML Canvas

### 本地开发

需要 Node.js 20 或更高版本。

```sh
git clone https://github.com/NanYuJun/AssetGrid.git
cd AssetGrid
npm install
npm run dev
```

打开 Vite 输出的本地地址。生产构建：

```sh
npm run build
npm run preview
```

### 图片与数据

作品图片、DIY 模板和作品数据只保存在当前浏览器的 IndexedDB 中，不会由本应用上传到服务器。清理浏览器站点数据会删除本地作品与素材；在清理数据或换电脑前，请先导出 JSON 备份。

### 开源协议

本项目采用 [Apache License 2.0](./LICENSE) 开源协议。
