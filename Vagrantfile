VM1_IP = "192.168.56.10"
VM2_IP = "192.168.56.11"
VM1_PORTS = "3002"
VM2_PORTS = "3003,3004,3005,3306"

Vagrant.configure("2") do |config|
  config.vm.box = "ubuntu/jammy64"
  config.vm.boot_timeout = 600

  config.vm.define "vm2" do |vm|
    vm.vm.hostname = "tickethub-vm2"
    vm.vm.network "private_network", ip: VM2_IP
    vm.vm.provider "virtualbox" do |vb|
      vb.name = "tickethub-vm2"
      vb.memory = Integer(ENV.fetch("VM2_MEMORY", "3072"))
      vb.cpus = 2
    end
    vm.vm.provision "shell", path: "deploy/provision.sh", args: ["vm2", VM2_IP, VM1_IP, VM2_PORTS]
  end

  config.vm.define "vm1", primary: true do |vm|
    vm.vm.hostname = "tickethub-vm1"
    vm.vm.network "private_network", ip: VM1_IP
    vm.vm.network "forwarded_port", guest: 8080, host: 8080, host_ip: "127.0.0.1"
    vm.vm.provider "virtualbox" do |vb|
      vb.name = "tickethub-vm1"
      vb.memory = Integer(ENV.fetch("VM1_MEMORY", "2048"))
      vb.cpus = 2
    end
    vm.vm.provision "shell", path: "deploy/provision.sh", args: ["vm1", VM1_IP, VM2_IP, VM1_PORTS]
  end
end
