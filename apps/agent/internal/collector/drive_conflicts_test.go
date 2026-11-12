package collector

import "testing"

func TestParseConflictCreations(t *testing.T) {
	lines := []string{
		`2026-10-29T22:44:28 (32252:98496) [INFO] upload-handler.cpp.o(1251): version conflict. path: /Decor/x/VSM28MVHU01 tech pack.ai, base sync_id: 2546314, current sync_id: 2546332`,
		`2026-10-29T22:44:32 (32252:76032) [INFO] upload-handler.cpp.o(856): <UploadHandler> Upload Done [node 1289404][ver 2546345] >> '/Decor/x/VSM28MVHU01 tech pack_DERRICK-LAPTOP_Oct-29-224428-2026_Conflict.ai' | view 'mac'(20), by 'IML\Dsmith'(3948942344) - drive(Windows)`,
		`2026-10-29T22:44:32 (32252:76032) [INFO] download-handler.cpp.o(319): <DownloadHandler> Download Done >> '/Decor/x/VSM28MVHU01 tech pack_DERRICK-LAPTOP_Oct-29-224428-2026_Conflict.ai' @ 2546345 | view 'mac'(20), by 'ahazan'(1033) - serversync(DiskStation)`,
		`2026-10-01T10:00:00 (1:1) [INFO] upload-handler.cpp.o(856): <UploadHandler> Upload Done [node 9][ver 1] >> '/old_ADMIN_Oct-01-100000-2026_Conflict.psd' | view 'mac'(20), by 'root'(0) - drive(Mac)`,
		`2026-10-14T11:47:09 (16803:41920) [INFO] native-sync-task.cpp.o(977): <NativeUpload> [20] '/Decor/W/Canvas8x51-SpiderMan6-Mockup_ADMIN_Oct-14-114646-2026_Conflict.ai' (node 1280239) (file) has been updated, new version 1`,
		`2026-10-15T15:27:12 (16803:41920) [INFO] native-sync-task.cpp.o(977): <NativeUpload> [20] '/Decor/F/F0M78VMSB01_LICENSING SHEET_DESKTOP-FFV7J81_mar.-19-152438-2026_Conflict.ai' (node 1139209) (file) has been updated, new version 2`,
		`2026-10-16T08:00:00 (1:1) [INFO] native-sync-task.cpp.o(977): <NativeUpload> [20] '/Decor/S/Soft_ZAR-LAPTOP_oct.-15-103301-2026_Conflict.ai' (node 77) (file) has been updated, new version 3`,
	}
	got := parseConflictCreations(lines, "2026-10-28T22:44:32")
	if len(got) != 1 {
		t.Fatalf("want 1 conflict, got %d: %+v", len(got), got)
	}
	k := got[0]
	if k.Node != "1289404" || k.Share != "mac" || k.User != `IML\Dsmith` || k.Client != "drive(Windows)" || k.Device != "DERRICK-LAPTOP" {
		t.Fatalf("bad parse: %+v", k)
	}
	native := parseConflictCreations(lines, "2026-10-14T00:00:00")
	if len(native) != 3 || native[1].Node != "1280239" || native[1].Share != "mac" || native[1].Device != "ADMIN" || native[2].Device != "ZAR-LAPTOP" {
		t.Fatalf("native parse wrong (old moved copy must be skipped): %+v", native)
	}
	if latestLogTime(lines) != "2026-10-16T08:00:00" {
		t.Fatalf("latestLogTime wrong")
	}
}
