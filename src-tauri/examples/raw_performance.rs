fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: raw_performance <RAW path> [binary output path]");
    let output = args.next();
    for iteration in 0..3 {
        let report = darkslide_lib::benchmark_raw(&path, if iteration == 0 { output.as_deref() } else { None })
            .expect("RAW decode failed");
        println!("{}", serde_json::to_string(&report).unwrap());
    }
}
