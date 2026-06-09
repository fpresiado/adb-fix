// adbpd-launcher — NSSM shim for ADB Proxy Daemon
//
// WHY THIS EXISTS:
//   NSSM spawns bun with bInheritHandles=TRUE (Windows default). When bun
//   creates the 5037 listen socket and is then killed/restarted, the kernel
//   keeps the socket alive because NSSM inherited a copy of the handle. The
//   new bun gets EADDRINUSE on bind — the "5037 kernel zombie" pattern.
//
// THE TWO-PART FIX:
//
//   Part 1 — PROC_THREAD_ATTRIBUTE_HANDLE_LIST:
//     bun is spawned with an explicit allowlist: stdin/stdout/stderr ONLY.
//     No other handles (sockets, pipes) leak into bun's handle table.
//
//   Part 2 — JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE:
//     bun is placed in a Job Object owned by this launcher. When NSSM kills
//     the launcher (TerminateProcess, Ctrl+C, service stop), the Job Object
//     handle is closed, which immediately terminates bun too. Without this,
//     NSSM only kills the launcher; bun becomes an orphan still holding 5037.
//
// USAGE (via NSSM):
//   Application:    M:\FutureApps\adb-proxy-daemon\launcher\target\release\adbpd-launcher.exe
//   AppParameters:  "C:\Users\plusu\.bun\bin\bun.exe" run "M:\FutureApps\adb-proxy-daemon\src\main.ts"
//   AppDirectory:   M:\FutureApps\adb-proxy-daemon

#![cfg(windows)]

use std::{env, ffi::OsString, process};

use windows::{
    core::PWSTR,
    Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{
            Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE},
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                QueryInformationJobObject, SetInformationJobObject,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
            Threading::{
                CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
                InitializeProcThreadAttributeList, UpdateProcThreadAttribute,
                WaitForSingleObject, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
                LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_CREATION_FLAGS, PROCESS_INFORMATION,
                STARTUPINFOEXW, STARTF_USESTDHANDLES,
            },
        },
    },
};

// PROC_THREAD_ATTRIBUTE_HANDLE_LIST = ProcThreadAttributeValue(2, FALSE, TRUE, FALSE)
const ATTR_HANDLE_LIST: usize = 0x0002_0002;

fn main() {
    let args: Vec<OsString> = env::args_os().collect();
    if args.len() < 2 {
        eprintln!("[adbpd-launcher] error: no target specified");
        eprintln!("usage: adbpd-launcher.exe <exe> [args...]");
        process::exit(1);
    }

    let cmdline = build_cmdline(&args[1..]);
    let mut cmdline_w: Vec<u16> = cmdline.encode_utf16().chain(std::iter::once(0)).collect();

    // --- Part 1: build the restricted handle inherit list (stdio only) ---

    let stdin  = unsafe { GetStdHandle(STD_INPUT_HANDLE).unwrap_or(HANDLE::default()) };
    let stdout = unsafe { GetStdHandle(STD_OUTPUT_HANDLE).unwrap_or(HANDLE::default()) };
    let stderr = unsafe { GetStdHandle(STD_ERROR_HANDLE).unwrap_or(HANDLE::default()) };

    let inherit_list: Vec<HANDLE> = [stdin, stdout, stderr]
        .into_iter()
        .filter(|h| !h.is_invalid())
        .collect();

    let mut attr_size: usize = 0;
    unsafe {
        let _ = InitializeProcThreadAttributeList(
            LPPROC_THREAD_ATTRIBUTE_LIST(std::ptr::null_mut()),
            1, 0, &mut attr_size,
        );
    }
    let mut attr_buf = vec![0u8; attr_size];
    let attr_list = LPPROC_THREAD_ATTRIBUTE_LIST(attr_buf.as_mut_ptr() as _);

    unsafe {
        InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_size)
            .expect("[adbpd-launcher] InitializeProcThreadAttributeList failed");
        UpdateProcThreadAttribute(
            attr_list, 0, ATTR_HANDLE_LIST,
            Some(inherit_list.as_ptr() as _),
            inherit_list.len() * std::mem::size_of::<HANDLE>(),
            None, None,
        )
        .expect("[adbpd-launcher] UpdateProcThreadAttribute failed");
    }

    let mut si = STARTUPINFOEXW::default();
    si.StartupInfo.cb         = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    si.StartupInfo.dwFlags    = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput  = stdin;
    si.StartupInfo.hStdOutput = stdout;
    si.StartupInfo.hStdError  = stderr;
    si.lpAttributeList        = attr_list;

    // --- Part 2: create a Job Object that kills bun when we exit ---

    let job: HANDLE = unsafe {
        CreateJobObjectW(None, None).expect("[adbpd-launcher] CreateJobObjectW failed")
    };

    // Read current limits, then add KILL_ON_JOB_CLOSE
    let mut ext_info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    unsafe {
        QueryInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &mut ext_info as *mut _ as _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            None,
        )
        .expect("[adbpd-launcher] QueryInformationJobObject failed");
    }
    ext_info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &ext_info as *const _ as _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
        .expect("[adbpd-launcher] SetInformationJobObject failed");
    }

    // --- Spawn bun ---

    let mut pi = PROCESS_INFORMATION::default();
    let result = unsafe {
        CreateProcessW(
            None,
            PWSTR(cmdline_w.as_mut_ptr()),
            None, None,
            true,   // bInheritHandles — restricted by ATTR_HANDLE_LIST above
            PROCESS_CREATION_FLAGS(EXTENDED_STARTUPINFO_PRESENT.0),
            None, None,
            &si.StartupInfo as *const _ as _,
            &mut pi,
        )
    };

    unsafe { DeleteProcThreadAttributeList(attr_list) };

    match result {
        Ok(_) => {}
        Err(e) => {
            eprintln!("[adbpd-launcher] CreateProcessW failed: {e}");
            unsafe { let _ = CloseHandle(job); }
            process::exit(1);
        }
    }

    // Assign bun to the Job Object — if we exit for any reason, bun dies too
    unsafe {
        AssignProcessToJobObject(job, pi.hProcess)
            .expect("[adbpd-launcher] AssignProcessToJobObject failed");
    }

    // Wait for bun to exit naturally, then forward its exit code
    let exit_code = unsafe {
        WaitForSingleObject(pi.hProcess, INFINITE);
        let mut code = 1u32;
        let _ = GetExitCodeProcess(pi.hProcess, &mut code);
        let _ = CloseHandle(pi.hProcess);
        let _ = CloseHandle(pi.hThread);
        let _ = CloseHandle(job);
        code
    };

    process::exit(exit_code as i32);
}

fn build_cmdline(args: &[OsString]) -> String {
    args.iter()
        .map(|a| {
            let s = a.to_string_lossy();
            if s.contains(' ') || s.contains('\t') || s.contains('"') {
                format!("\"{}\"", s.replace('"', "\\\""))
            } else {
                s.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}
