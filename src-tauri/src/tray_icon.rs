//! Renders the menubar widget as an image: a small grey pill containing a
//! play glyph + "zzzz" when idle, or pause bars + the elapsed time while a
//! timer runs. Text is set in SF Rounded (loaded from the system on macOS;
//! bundled Varela Round elsewhere) — menubar titles can't do custom fonts
//! or pill backgrounds, so the whole widget is drawn as the tray icon.
//!
//! Every character is laid out in a fixed-width cell (the widest digit), so
//! ticking time and the idle "zzzz"→"zebu" hover roll never shift around.

use ab_glyph::{Font, FontVec, PxScale, PxScaleFont, ScaleFont};
use std::sync::OnceLock;
use tiny_skia::{Color, ColorU8, FillRule, Paint, PathBuilder, Pixmap, Transform};

/// Backing-store scale: the menubar shows the widget at 18pt, so drawing every
/// pixel twice over keeps text and edges crisp on Retina displays.
const SCALE: f32 = 2.0;
const HEIGHT: u32 = 18;
const MIN_WIDTH: f32 = 52.0;
const RADIUS: f32 = 2.0;
const TEXT_SIZE: f32 = 13.0;
const GLYPH_END: f32 = 15.0; // play/pause artwork lives left of this

pub enum Glyph {
    Play,
    Pause,
}

static FONT: OnceLock<FontVec> = OnceLock::new();

fn font() -> &'static FontVec {
    FONT.get_or_init(|| {
        #[cfg(target_os = "macos")]
        for path in [
            "/System/Library/Fonts/SFRounded.ttf",
            "/System/Library/Fonts/SFNSRounded.ttf",
        ] {
            if let Ok(bytes) = std::fs::read(path) {
                if let Ok(f) = FontVec::try_from_vec(bytes) {
                    return f;
                }
            }
        }

        FontVec::try_from_vec(include_bytes!("../fonts/VarelaRound-Regular.ttf").to_vec())
            .expect("bundled fallback font is valid")
    })
}

/// The widget image: `Some("1:20")` renders the running state, `None` idle.
///
/// On macOS this is a template image (black + alpha only): the menubar
/// recolors it per appearance — black on a light menubar, a subdued white in
/// dark mode — which is the HIG-sanctioned way to adapt. The 15%-alpha pill
/// renders as exactly the design's #d9d9d9 on a light menubar. Other
/// platforms get the literal grey pill.
pub fn render(elapsed: Option<&str>, running: bool) -> Option<(tauri::image::Image<'static>, bool)> {
    match (elapsed, running) {
        // running is drawn in colour (green pause bars), so no template mode
        (Some(t), true) => render_custom(Glyph::Pause, t, false, false),
        // stopped, but there's time on the clock today: a quiet paused pill
        (Some(t), false) => render_custom(Glyph::Play, t, false, cfg!(target_os = "macos")),
        // nothing tracked today at all
        (None, _) => render_custom(Glyph::Play, "zzzz", true, cfg!(target_os = "macos")),
    }
}

fn render_custom(glyph: Glyph, text: &str, centered: bool, template: bool) -> Option<(tauri::image::Image<'static>, bool)> {
    let pixmap = render_pixmap(glyph, text, centered, template)?;

    // premultiplied tiny-skia pixels -> straight RGBA for the tray
    let (width, height) = (pixmap.width(), pixmap.height());
    let rgba: Vec<u8> = pixmap
        .pixels()
        .iter()
        .flat_map(|p| {
            let d = p.demultiply();
            [d.red(), d.green(), d.blue(), d.alpha()]
        })
        .collect();

    Some((tauri::image::Image::new_owned(rgba, width, height), template))
}

fn render_pixmap(glyph: Glyph, text: &str, centered: bool, template: bool) -> Option<Pixmap> {
    let scaled = font().as_scaled(PxScale::from(TEXT_SIZE));
    let cell = digit_cell(&scaled);
    let raster = font().as_scaled(PxScale::from(TEXT_SIZE * SCALE));
    let text_width = cell * text.chars().count() as f32;

    // idle text is centered in a fixed-width pill; the running time grows
    // the pill only when it gains a digit
    let width = if centered {
        MIN_WIDTH
    } else {
        MIN_WIDTH.max(22.0 + text_width + 6.0).ceil()
    };

    let mut pixmap = Pixmap::new((width * SCALE) as u32, (HEIGHT as f32 * SCALE) as u32)?;
    let scale = Transform::from_scale(SCALE, SCALE);

    // the pill: as a template, 15% black — which the menubar renders as
    // #d9d9d9 on light, and a faint white in dark mode
    let mut paint = Paint::default();
    paint.set_color(if template {
        Color::from_rgba8(0x00, 0x00, 0x00, 38)
    } else {
        Color::from_rgba8(0xd9, 0xd9, 0xd9, 0xff)
    });
    paint.anti_alias = true;
    let pill = rounded_rect(0.0, 0.0, width, HEIGHT as f32, RADIUS)?;
    pixmap.fill_path(&pill, &paint, FillRule::Winding, scale, None);

    let mut ink = Paint::default();
    ink.set_color(Color::BLACK);
    ink.anti_alias = true;
    match glyph {
        Glyph::Pause => {
            // branding green — the reason the running pill skips template mode
            ink.set_color(Color::from_rgba8(0x16, 0xa3, 0x4a, 0xff));
            for x in [5.0f32, 9.0] {
                let bar = rounded_rect(x, 5.0, 3.0, 8.0, 1.0)?;
                pixmap.fill_path(&bar, &ink, FillRule::Winding, scale, None);
            }
        }
        Glyph::Play => {
            let mut pb = PathBuilder::new();
            pb.move_to(5.5, 4.5);
            pb.line_to(13.5, 9.0);
            pb.line_to(5.5, 13.5);
            pb.close();
            pixmap.fill_path(&pb.finish()?, &ink, FillRule::Winding, scale, None);
        }
    }

    let text_x = if centered {
        GLYPH_END + ((width - 4.0 - GLYPH_END) - text_width) / 2.0
    } else {
        22.0
    };
    draw_text(&mut pixmap, &raster, text, text_x * SCALE, cell * SCALE);

    Some(pixmap)
}

fn rounded_rect(x: f32, y: f32, w: f32, h: f32, r: f32) -> Option<tiny_skia::Path> {
    let mut pb = PathBuilder::new();
    pb.move_to(x + r, y);
    pb.line_to(x + w - r, y);
    pb.quad_to(x + w, y, x + w, y + r);
    pb.line_to(x + w, y + h - r);
    pb.quad_to(x + w, y + h, x + w - r, y + h);
    pb.line_to(x + r, y + h);
    pb.quad_to(x, y + h, x, y + h - r);
    pb.line_to(x, y + r);
    pb.quad_to(x, y, x + r, y);
    pb.close();
    pb.finish()
}

/// The fixed advance every character gets: the widest digit.
fn digit_cell(scaled: &PxScaleFont<&'static FontVec>) -> f32 {
    "0123456789"
        .chars()
        .map(|c| scaled.h_advance(scaled.glyph_id(c)))
        .fold(0.0, f32::max)
}

fn draw_text(pixmap: &mut Pixmap, scaled: &PxScaleFont<&'static FontVec>, text: &str, x: f32, cell: f32) {
    // measure the actual ink extents at a zero baseline, then centre exactly —
    // "zzzz" (x-height) and "1:20" (cap height) both land dead centre
    let mut min_y = f32::MAX;
    let mut max_y = f32::MIN;
    for ch in text.chars() {
        let id = scaled.glyph_id(ch);
        let glyph = id.with_scale_and_position(scaled.scale(), ab_glyph::point(0.0, 0.0));
        if let Some(outlined) = font().outline_glyph(glyph) {
            let b = outlined.px_bounds();
            min_y = min_y.min(b.min.y);
            max_y = max_y.max(b.max.y);
        }
    }
    if min_y > max_y {
        return; // nothing to draw
    }
    let baseline = (HEIGHT as f32 * SCALE - (max_y - min_y)) / 2.0 - min_y;
    let width = pixmap.width() as i32;
    let height = pixmap.height() as i32;
    let pixels = pixmap.pixels_mut();

    for (i, ch) in text.chars().enumerate() {
        let id = scaled.glyph_id(ch);
        // centre each glyph inside its fixed cell
        let caret = x + cell * i as f32 + (cell - scaled.h_advance(id)) / 2.0;
        let glyph = id.with_scale_and_position(scaled.scale(), ab_glyph::point(caret, baseline));
        if let Some(outlined) = font().outline_glyph(glyph) {
            let bounds = outlined.px_bounds();
            outlined.draw(|gx, gy, coverage| {
                let px = bounds.min.x as i32 + gx as i32;
                let py = bounds.min.y as i32 + gy as i32;
                if px < 0 || py < 0 || px >= width || py >= height || coverage <= 0.0 {
                    return;
                }
                let idx = (py * width + px) as usize;
                let dest = pixels[idx].demultiply();
                let inv = 1.0 - coverage;
                // black ink over the destination, premultiplied on store
                pixels[idx] = ColorU8::from_rgba(
                    (dest.red() as f32 * inv) as u8,
                    (dest.green() as f32 * inv) as u8,
                    (dest.blue() as f32 * inv) as u8,
                    (255.0 * coverage + dest.alpha() as f32 * inv) as u8,
                )
                .premultiply();
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_both_states() {
        let dir = std::env::temp_dir().join("zebu-tray-preview");
        std::fs::create_dir_all(&dir).unwrap();

        let idle = render_pixmap(Glyph::Play, "zzzz", true, false).unwrap();
        // drawn at SCALE x for Retina: the backing store is twice the 18pt menubar height
        assert_eq!(idle.height(), (HEIGHT as f32 * SCALE) as u32);
        assert_eq!(idle.width(), (MIN_WIDTH * SCALE) as u32);
        idle.save_png(dir.join("idle.png")).unwrap();

        let running = render_pixmap(Glyph::Pause, "1:20", false, false).unwrap();
        running.save_png(dir.join("running.png")).unwrap();

        render_pixmap(Glyph::Pause, "12:45", false, false)
            .unwrap()
            .save_png(dir.join("long.png"))
            .unwrap();
    }
}
