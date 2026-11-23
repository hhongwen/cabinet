param([string]$Initial = "")

# 用 IFileOpenDialog + FOS_PICKFOLDERS 弹 Vista+ 风格的目录选择器
# （就是 Win11 资源管理器那种：带地址栏、搜索、详细信息列表）
# 老式的 FolderBrowserDialog 是树形控件，不好用。
#
# 不设置任何中文文本，用系统自带的本地化标题，绕开 .ps1 编码问题。

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace FolderPick
{
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
        void GetResults(out IntPtr ppenum);
        void GetSelectedItems(out IntPtr ppsai);
    }

    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    public class FileOpenDialogRCW { }

    public static class Picker
    {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        static extern void SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
            IntPtr pbc,
            ref Guid riid,
            [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

        public static string Pick(string initial)
        {
            var dlg = (IFileOpenDialog)new FileOpenDialogRCW();

            uint opts;
            dlg.GetOptions(out opts);
            // FOS_PICKFOLDERS(0x20) 只选目录 / FOS_FORCEFILESYSTEM(0x40) 只要真实路径
            dlg.SetOptions(opts | 0x20u | 0x40u);

            if (!string.IsNullOrWhiteSpace(initial))
            {
                try
                {
                    var iid = typeof(IShellItem).GUID;
                    IShellItem item;
                    SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out item);
                    if (item != null) dlg.SetFolder(item);
                }
                catch { /* 初始目录无效就忽略，让它用默认 */ }
            }

            // 0 = 成功，1 = 取消
            int hr = dlg.Show(IntPtr.Zero);
            if (hr != 0) return null;

            IShellItem result;
            dlg.GetResult(out result);
            if (result == null) return null;

            string path;
            result.GetDisplayName(0x80058000u, out path);   // SIGDN_FILESYSPATH
            return path;
        }
    }
}
'@

try {
  $picked = [FolderPick.Picker]::Pick($Initial)
  if ($picked) { [Console]::Out.Write($picked) }
}
catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
exit 0
