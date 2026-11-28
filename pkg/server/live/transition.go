package live

import (
	"fmt"
	"math"
	"math/rand/v2"
	"strings"
	"time"

	"github.com/gdamore/tcell/v2"
	"github.com/mattn/go-runewidth"
	"github.com/rivo/uniseg"

	"link-chat/pkg/i18n"
	"link-chat/pkg/server"
	"link-chat/pkg/tui/anim"
	"link-chat/pkg/tui/widget"
)

const (
	crtDuration           = 480 * time.Millisecond
	moduleDuration        = 720 * time.Millisecond
	shutdownBackgroundEnd = 1420 * time.Millisecond
	shutdownSweep         = 1550 * time.Millisecond
	completionPause       = 130 * time.Millisecond
	shutdownCRT           = 250 * time.Millisecond
	blackPause            = 65 * time.Millisecond
)

type dashboardTransition struct {
	started, stopping, finished time.Time
	curtainAt                   time.Time
	progress                    int
	background                  shutdownFrame
}

func fraction(elapsed, duration time.Duration) float64 {
	return min(1, max(0, float64(elapsed)/float64(duration)))
}

func (t *dashboardTransition) drawStartup(screen tcell.Screen, d *dashboard, now time.Time) bool {
	elapsed := now.Sub(t.started)
	if elapsed < crtDuration {
		drawCRT(screen, fraction(elapsed, crtDuration))
		return true
	}
	if elapsed < crtDuration+moduleDuration {
		d.drawModules(screen, now, fraction(elapsed-crtDuration, moduleDuration))
		return true
	}
	return false
}

// drawShutdown returns true after the final black frame has been held.
func (t *dashboardTransition) drawShutdown(screen tcell.Screen, d *dashboard, now time.Time, phase server.ShutdownPhase) bool {
	elapsed := max(0, now.Sub(t.stopping))
	if !t.curtainAt.IsZero() && !now.Before(t.curtainAt) {
		if d.still {
			return true
		}
		out := now.Sub(t.curtainAt)
		drawCRT(screen, 1-fraction(out, shutdownCRT))
		return out >= shutdownCRT+blackPause
	}

	screen.Clear()
	if !d.still && elapsed < shutdownBackgroundEnd {
		w, h := screen.Size()
		if t.background.width != w || t.background.height != h || !t.background.captured {
			t.background.capture(screen, d, t.stopping)
			screen.Clear()
		}
		t.background.draw(screen, elapsed)
	}

	done := !t.finished.IsZero()
	target, detail := shutdownCheckpoint(phase, d.lang)
	if done {
		target, detail = 100, tr(d.lang, "通信与存储已关闭", "Connections and storage are closed")
		if phase == server.ShutdownGraceExpired {
			detail = tr(d.lang, "连接等待超时，存储已关闭", "Connection drain timed out. Storage is closed.")
		}
	}
	// The sweep sets the presentation speed; the server still controls which
	// checkpoint may be shown, including the final 100 percent.
	clock := fraction(elapsed, shutdownSweep)
	visual := int(100 * (.64*clock + .36*anim.EaseOutCubic(clock)))
	if d.still {
		visual = target
	}
	t.progress = min(target, max(t.progress, visual))
	if t.progress == 100 && t.curtainAt.IsZero() {
		t.curtainAt = now.Add(completionPause)
	}

	drawShutdownProgress(screen, t.progress, detail, elapsed, !d.still, d.lang)
	screen.Show()
	return false
}

type shutdownFrame struct {
	width, height int
	captured      bool
	units         []shutdownUnit
}

type shutdownCell struct {
	x, y, width int
	glyph       string
	style       tcell.Style
}

type shutdownUnit struct {
	cells []shutdownCell
	until time.Duration
}

type shutdownPane struct {
	items  [][]shutdownCell
	header []shutdownCell
	weight int
}

func shutdownRow(screen tcell.Screen, left, right, y int) []shutdownCell {
	var cells []shutdownCell
	for x := left; x < right; {
		glyph, style, width := screen.Get(x, y)
		width = max(1, width)
		if glyph != "" && (glyph != " " || style != tcell.StyleDefault) {
			cells = append(cells, shutdownCell{x, y, width, glyph, style})
		}
		x += width
	}
	return cells
}

func shutdownRows(screen tcell.Screen, left, right, top, bottom, weight int) shutdownPane {
	pane := shutdownPane{weight: weight}
	if top >= bottom || left >= right {
		return pane
	}
	pane.header = shutdownRow(screen, left, right, top)
	for y := top + 1; y < bottom; y++ {
		if row := shutdownRow(screen, left, right, y); len(row) > 0 {
			pane.items = append(pane.items, row)
		}
	}
	return pane
}

func (frame *shutdownFrame) capture(screen tcell.Screen, d *dashboard, stoppedAt time.Time) {
	frame.width, frame.height = screen.Size()
	frame.captured = true
	frame.units = frame.units[:0]

	// Exclude in-flight message traces when recording the settled layout.
	display := *d
	display.links = nil
	display.paint(screen, stoppedAt)
	w, h := frame.width, frame.height
	var panes []shutdownPane
	if d.page != noDetails || d.systemExpanded || h < 6 {
		panes = append(panes, shutdownRows(screen, 0, w, 0, h, 1))
	} else {
		divider, split := dashboardBody(w, h)
		users := shutdownPane{header: shutdownRow(screen, 0, split, 2), weight: 4}
		for y := 3; y < divider; y++ {
			row := shutdownRow(screen, 0, split, y)
			// Usernames are separated by column gaps. A whole name or the
			// remaining-users caption stays together as a single unit.
			start := 0
			for i := 1; i < len(row); i++ {
				previous := row[i-1]
				if row[i].x-previous.x-previous.width >= 2 {
					users.items = append(users.items, row[start:i])
					start = i
				}
			}
			if start < len(row) {
				users.items = append(users.items, row[start:])
			}
		}
		rng := rand.New(rand.NewPCG(uint64(stoppedAt.UnixNano()), 0))
		rng.Shuffle(len(users.items), func(i, j int) { users.items[i], users.items[j] = users.items[j], users.items[i] })
		panes = append(panes, users)

		if split < w {
			channels := shutdownPane{header: shutdownRow(screen, split, w, 2), weight: 2}
			for y := 3; y < divider; y++ {
				channels.header = append(channels.header, shutdownRow(screen, split, split+1, y)...)
			}
			for y := 3; y < divider; y += 3 {
				var box []shutdownCell
				for row := y; row < min(y+3, divider); row++ {
					box = append(box, shutdownRow(screen, split+1, w, row)...)
				}
				if len(box) > 0 {
					channels.items = append(channels.items, box)
				}
			}
			panes = append(panes, channels)
		}
		for i := range server.ActivityCategories() {
			left, right := panelBounds(w, i)
			panes = append(panes, shutdownRows(screen, left, right, divider+1, h, 1))
		}
		bands := shutdownPane{weight: 1}
		bands.items = append(bands.items, shutdownRow(screen, 0, w, divider), shutdownRow(screen, 0, w, 1))
		bands.header = shutdownRow(screen, 0, w, 0)
		panes = append(panes, bands)
	}

	totalWeight := 0
	for _, pane := range panes {
		totalWeight += pane.weight
	}
	var start time.Duration
	for _, pane := range panes {
		duration := shutdownBackgroundEnd * time.Duration(pane.weight) / time.Duration(totalWeight)
		for i, cells := range pane.items {
			until := start + duration*time.Duration(i+1)/time.Duration(len(pane.items)+1)
			frame.units = append(frame.units, shutdownUnit{cells, until})
		}
		start += duration
		frame.units = append(frame.units, shutdownUnit{pane.header, start})
	}
}

func (frame shutdownFrame) draw(screen tcell.Screen, elapsed time.Duration) {
	for _, unit := range frame.units {
		if elapsed < unit.until {
			for _, cell := range unit.cells {
				screen.Put(cell.x, cell.y, cell.glyph, cell.style)
			}
		}
	}
}

func shutdownCheckpoint(phase server.ShutdownPhase, lang i18n.Lang) (int, string) {
	switch phase {
	case server.ShutdownNotifying:
		return 22, tr(lang, "通知客户端并停止接收新连接", "Notifying clients and stopping new connections")
	case server.ShutdownStoppingHTTP:
		return 42, tr(lang, "正在关闭 HTTP 监听", "Closing the HTTP listener")
	case server.ShutdownDraining:
		return 72, tr(lang, "等待现有连接和请求退出", "Waiting for connections and requests to finish")
	case server.ShutdownDrained:
		return 95, tr(lang, "连接已退出，正在关闭数据存储", "Connections closed. Closing storage.")
	case server.ShutdownGraceExpired:
		return 95, tr(lang, "连接等待超时，正在关闭数据存储", "Connection drain timed out. Closing storage.")
	default:
		return 10, tr(lang, "正在准备关停", "Preparing shutdown")
	}
}

func drawShutdownProgress(screen tcell.Screen, percent int, detail string, elapsed time.Duration, moving bool, lang i18n.Lang) {
	w, h := screen.Size()
	if w < 1 || h < 1 {
		return
	}
	middle := h / 2
	title := fmt.Sprintf(tr(lang, "正在关停  %d%%", "Shutting down  %d%%"), percent)
	if percent == 100 {
		title = tr(lang, "关停完成  100%", "Shutdown complete  100%")
	}
	if h < 7 || w < 16 {
		centerText(screen, 0, w, max(0, middle-1), title, accent.Bold(true))
		if h >= 2 {
			centerText(screen, 0, w, middle, detail, bright)
		}
		return
	}

	background := tcell.NewHexColor(0x101923)
	withCard := func(style tcell.Style) tcell.Style {
		return style.Background(background)
	}
	cardWidth := min(58, w-4)
	cardX := (w - cardWidth) / 2
	card := withCard(tcell.StyleDefault)
	for y := middle - 3; y <= middle+3; y++ {
		screen.PutStrStyled(cardX, y, strings.Repeat(" ", cardWidth), card)
	}
	centerText(screen, cardX, cardWidth, middle-2, title, withCard(accent.Bold(true)))
	barWidth := cardWidth - 8
	barX := (w - barWidth) / 2
	track := withCard(tcell.StyleDefault.Foreground(tcell.NewHexColor(0x415469)))
	drawRule(screen, barX, middle, barWidth, track)
	filled := barWidth * percent / 100
	if filled > 0 {
		drawRule(screen, barX, middle, filled-1, withCard(accent.Bold(true)))
		drawRule(screen, barX+filled-1, middle, 1, withCard(bright.Bold(true)))
	}
	if moving && elapsed >= shutdownSweep && percent < 100 && filled < barWidth {
		// A low-contrast pulse indicates a live wait on the unfilled track.
		remaining := barWidth - filled
		head := int(elapsed/(65*time.Millisecond)) % remaining
		drawRule(screen, barX+filled+head, middle, 1, withCard(muted))
	}
	centerText(screen, cardX, cardWidth, middle+1, detail, withCard(bright))
	if percent < 100 {
		centerText(screen, cardX, cardWidth, middle+2, fmt.Sprintf(tr(lang, "已用时 %.1f 秒", "Elapsed %.1f s"), elapsed.Seconds()), withCard(muted))
	}
}

func centerText(screen tcell.Screen, x, width, y int, text string, style tcell.Style) {
	text = runewidth.Truncate(text, width, "")
	screen.PutStrStyled(x+max(0, (width-uniseg.StringWidth(text))/2), y, text, style)
}

// drawCRT uses one openness value in both directions. At the center the two
// edges join into a flash, which narrows to a single point before going dark.
func drawCRT(screen tcell.Screen, openness float64) {
	screen.Fill(' ', tcell.StyleDefault.Background(tcell.ColorBlack))
	w, h := screen.Size()
	if openness > 0 && w > 0 && h > 0 {
		const flash = 0.25
		if openness < flash {
			length := max(1, int(math.Round(float64(w)*openness/flash)))
			drawRule(screen, (w-length)/2, (h-1)/2, length, bright.Background(tcell.ColorBlack).Bold(true))
		} else {
			spread := anim.EaseOutCubic((openness - flash) / (1 - flash))
			upper := int(math.Round(float64((h-1)/2) * (1 - spread)))
			lower := h - 1 - upper
			edge := accent.Background(tcell.ColorBlack).Bold(true)
			drawRule(screen, 0, upper, w, edge)
			if lower != upper {
				drawRule(screen, 0, lower, w, edge)
			}
		}
	}
	screen.Show()
}

func (d *dashboard) drawModules(screen tcell.Screen, now time.Time, openness float64) {
	d.paint(screen, now)
	w, h := screen.Size()
	clip := func(index int, region widget.Rect) {
		visible := anim.EaseOutCubic((openness - 0.074*float64(index)) / 0.48)
		clipModule(screen, region, visible)
	}
	if d.systemExpanded || h < 6 {
		clip(0, widget.Rect{W: w, H: h})
	} else {
		divider, split := dashboardBody(w, h)
		clip(0, widget.Rect{W: w, H: 2})
		clip(1, widget.Rect{Y: 2, W: split, H: divider - 2})
		clip(2, widget.Rect{X: split, Y: 2, W: w - split, H: divider - 2})
		clip(3, widget.Rect{Y: divider, W: w, H: 1})
		for i := range server.ActivityCategories() {
			left, right := panelBounds(w, i)
			clip(4+i, widget.Rect{X: left, Y: divider + 1, W: right - left, H: h - divider - 1})
		}
	}
	screen.Show()
}

// clipModule keeps a shrinking rectangle inside the module. Cells occupied by
// a wide glyph are cleared together when its glyph touches the clip edge.
func clipModule(screen tcell.Screen, r widget.Rect, visible float64) {
	if r.Empty() || visible >= 1 {
		return
	}
	width := int(math.Round(float64(r.W) * visible))
	height := int(math.Round(float64(r.H) * visible))
	left := r.X + (r.W-width)/2
	top := r.Y + (r.H-height)/2
	for y := r.Y; y < r.Y+r.H; y++ {
		for x := r.X; x < r.X+r.W; {
			_, _, cells := screen.Get(x, y)
			cells = max(1, cells)
			if y < top || y >= top+height || x < left || x+cells > left+width {
				screen.PutStrStyled(x, y, strings.Repeat(" ", cells), tcell.StyleDefault)
			}
			x += cells
		}
	}
}
